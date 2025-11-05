# Enhancement Plan: Translation & Proofread Pipelines

## Overview
- **Stability:** Recover automatically from JSON parse failures, truncation, and 429 errors across all pipeline stages.
- **UX:** Surface partial errors as sub-task retrying states while keeping run-level success/failure accurate.
- **Cost/SLA:** Improve perceived turnaround by 2–4× and cut excess tokens by 30–60 %.
- **Owner:** Codex (BE/FE). Work is staged in milestones below.

## Milestone 1 — Hotfix (Stability Foundations)
**Acceptance:** Unterminated JSON, truncation, or 429 no longer aborts translation/proofread runs; UI shows `recovering` until retries finish; partial failures never flip the run to failed immediately.

### Server
- Extend `safeExtractOpenAIResponse` (`server/services/llm.ts`) with JSON repair: strip control characters, balance braces/brackets, close missing quotes, record `repairApplied`.
- Update `runResponsesWithRetry` (`server/services/openaiResponses.ts`) so `truncated` only reflects the final response; retry sequence becomes `×1.5` → `×2 (cap)` → fallback model → segment-level retry hook.
- Refactor translation/proofread/quality/profile agents to rely solely on the shared parser (remove manual `JSON.parse`) and to record `jsonRepairApplied` in metadata.
- Introduce reusable NDJSON writer (`server/lib/ndjsonStream.ts`) and adopt it in streaming routes (`server/routes/evaluation.ts`, `server/routes/proofreading.ts`).

### Client
- Add shared NDJSON buffer (`web/src/lib/ndjsonBuffer.ts`) and update `web/src/services/sse.ts` + API streaming callers to use it.
- Redesign workflow store (`web/src/store/workflow.store.ts`) to track `run` (queued/running/recovering/done/failed) + `heartbeatAt`, `willRetry`, `nextRetryDelayMs`, and maintain `subStates` array for per-stage progress.
- Update translation hook (`web/src/hooks/useTranslationAgent.ts`) to drive the new run/sub states, emitting `recovering` and retry metadata for UI.

## Milestone 2 — Hardening & UX (Week 1)
**Acceptance:** End-to-end throughput improves ≥2× on the reference set; retry-induced tokens drop ≥30 %; timeline cards display completed/failed/retrying counts with retry ETA.

### Progress (current)
- ✅ Proofread SSE run_id 정합성 확보 (handshake 시 `workflow` runId 배제, stage/items runId 기반 재구독)
- ✅ A2/A3 교정 안정화 핵심 완료: heartbeat·재연결 메타 수집, zero-item run guard, pagination/rest 폴백 테스트
- ✅ 번역 Draft/Revise SSE 페이지네이션 및 `/translations/:runId/items` REST 폴백 구현 (SSE `has_more` → REST 큐 재흐름 검증 준비 완료)
- 🔄 실데이터 QA 및 스트림 메타 영속화/대시보드 반영 진행 예정 (운영 확인 후 follow-up 토스트/큐 흐름 최종 점검)

### Server (Proofread 차례 완료, Translation 확장 중)
- Proofread 파이프라인: response v2 + pagination + stream 메타 영속화 완료.
- Translation 파이프라인: Draft/Revise 단계가 `buildTranslationPages` 기반으로 분리되어 SSE/REST 양쪽에서 `has_more`/`next_cursor`를 제공. `/api/projects/:projectId/translations/:runId/items`로 REST 폴백을 재생성 가능.
- Translation 요약/스트림 메타: `stream_run_metrics` 스냅샷과 `/translations/summary` API로 런 상태를 복원하고, Follow-up 카운트를 헤더에서 확인하도록 구현 중 (장문 QA 후 지표 노출 검증 예정).
- **다음 리팩터링 계획** (아키텍트 확정)
  1. `useTranslationAgent` SSE 상태머신 전환
     - `connectionState: 'idle'|'connecting'|'streaming'|'backoff'` 도입
     - 스트림 열린 동안 Summary/Job 폴링 중단, 닫힐 때만 지수 백오프 재연결
     - 하이드레이션: 탭 진입/재접속 시 Summary 1회 + 스트림 연결, 그 외 폴링 제거
  2. `/translations/summary` 집계 정밀화
     - `segmentsTotal` = 최초 분할 수, `segmentsProcessed` = micro-check 완료 수, percent = round(processed/total * 100)
     - `translation.stages[].startedAt/completedAt`는 러너 이벤트 기반으로 세팅 (Draft/Revise/Micro-check)
     - Follow-up, pagination, usage는 stream-run-metrics + SSE 증분으로 일관 유지
  3. 스트림 파이프라인 보강
     - NDJSON 헤더/flush/heartbeat 재점검, 프록시에서 compression/버퍼링 비활성화
     - Draft/Revise 완료 시 `recordTranslationMetricsSnapshot`에 tokens_in/out, model, cost를 업서트
  4. 세그먼트 분할/토큰 상한 튜닝
     - paragraph 모드 분할기가 문단 수와 일치하도록 휴리스틱/해시 재검토,
       단위 테스트 추가
     - Draft/Revise `max_output_tokens`를 세그먼트 길이 기반으로 동적 산정 (예: min 120, max 800)
  5. QA 체크리스트
     - 단/장문 번역에서 `/translations/stream` 1회 연결 유지, Summary/Jobs 호출 0~2회,
       reconnectAttempts ≤ 1 확인
     - stage percent 단조 증가, micro-check 완료 시에만 100%
     - Follow-up 토스트/헤더 수치 일관 및 dismiss 후 재등장 조건 검증

### Client
- Proofread/Quality 훅은 run/sub-state 모델로 재정비 완료 (`useProofreadAgent`). Translation 훅도 동일 큐/폴백 패턴(`pendingCursors`/REST drain)까지 확장 완료, follow-up 토스트 QA만 남음.
- 타임라인/사이드바 배지는 Proofread 기준으로 일관화 되어 있으며, Translation 영역도 동일 지표를 수용하도록 조정 필요.

### Optimization (공통 성능/비용 개선)
- 부담이 큰 장편 시나리오에서도 안정성과 속도를 모두 확보하기 위해:
  - 프롬프트 다이어트(공통 룰 ID 참조, few-shot 최소화)와 페이징/다운시프트 안정화를 병행.
  - 번역 Draft 워커 동시성(4–8)과 Proofread 서브피처 병렬 처리로 체감 시간을 단축.
  - HTTP/2, keep-alive, 배치 I/O로 네트워크·DB 오버헤드를 줄이기.
- SLA 대시보드에 first_items_ms / total_ms P50·P90, downshift/forced_pagination 비율, 토큰/건을 노출해 병목 지점을 추적.
- 감당 가능한 청크 크기(700–900자, 1~2문장 오버랩)를 유지하고 필요 시 detection→revision 2-pass 흐름을 적용.
- 공통 retry orchestration이 Translation/Proofread/Quality에서 동일한 페이징·evidence 규칙을 사용하도록 정비.

## Milestone 3 — Performance & Cost (Week 2)
**Acceptance:** App P50 ≤ 35 s, P90 ≤ 60 s (ChatGPT baseline 15 s); monthly token cost down ≥40 %.

- Model mix: Draft on `*-mini`, Revise on `gpt-5 (thinking)`; Proof/QA use 10–20 % sampling with anomaly-triggered full reruns.
- Combine draft + light proof for short texts (≤1,200 chars) into single call.
- Optimize runtime IO: reuse OpenAI clients with keep-alive/HTTP2, batch final writes, limit logging to errors, warm tokenization/normalization to avoid cold starts.
- 재접속 UX 강화: active run snapshot API (`/workflows/:runId/summary` + `/projects/:id/workflows/active`) 제공, 클라이언트 진입 시 자동 재구독/상태 복원.
- SSE heartbeat + 폴백 전략을 번역/교정 공통으로 적용하고, 브라우저 재연결/다른 클라이언트 진입 케이스까지 검증.
- 성능 대시보드 확장: 번역/교정 P50/P90, 다운시프트 비율, cache hit-rate, 재접속 복구 지표(복구 시간, 실패율) 노출.

## Unified Stage Status Delivery
- Define shared status envelope (`status`, `subStatus`, `heartbeatAt`, `willRetry`, `nextRetryDelayMs`) for origin → translation → proofread → quality.
- Provide `/api/projects/:projectId/stages/status` snapshot endpoint; align translation polling response (`useTranslationAgent`) to use same schema.
- Client (`useProjectContext`, timeline, sidebar) consumes unified run/sub states for every stage, showing consistent badges and retry info.

## Test Matrix
1. **Partial JSON** – inject unterminated JSON and confirm run transitions to `recovering` with retries ending `done`/partial failure.
2. **Truncation** – force `max_output_tokens` exhaustion; verify `×1.5 → ×2 → fallback` without losing run context.
3. **Proofread subfailure** – emit subfeature error with `willRetry=true`; timeline remains `recovering`, run finishes.
4. **429** – confirm backoff + segment retry keeps run alive.
5. **Quality sampling** – run sample detection; verify anomaly triggers full rerun and logs detection rate.
6. **Performance baseline** – measure P50/P90 & tokens on small/medium/large docs pre- and post-fixes.

## Ops Visibility
- Extend run logs with `json_repair_count`, `retry_reason` (truncation|json|429), `segment_retry_count`, `cache_hit%`.
- Add dashboard widgets for latency, token usage, retry distribution; highlight recovering vs failure states per stage.

---

This plan reflects the backed-up implementation in `/tmp/plan/` and should be used as the authoritative guide when restoring or continuing work.
