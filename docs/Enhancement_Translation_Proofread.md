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
- 🔄 실데이터 QA 및 스트림 메타 영속화/대시보드 반영 진행 예정 (운영 확인 후 번역 파이프라인 확장으로 이어감)
- 🔜 공통 스키마/페이징을 번역 파이프라인에 확장 적용 (A2/A3 운영 검증 이후 착수)

### Server
- Introduce proofread/translation response v2 schema with range-based evidence only; forbid raw text echoes and shorten keys for lean NDJSON payloads. Update prompts accordingly.
- Add `has_more`/`next_cursor` pagination support to `runGenericWorker` and translation agents, limiting `max_items` per call (default 40 quick / 60 deep); retry paths down-shift token and item caps instead of expanding.
- Switch segmentation to token-based lengths (`segmentOriginText`) interpreting `SEGMENTATION_MAX_SEGMENT_LENGTH_V2` as token cap; target 65–75 % context usage.
- Expand Micro-check guards to auto-retry segments when length/sentence ratios fall outside 0.7–1.3; log `retry_reason`.
- Add duplicate sentence cache to reuse prior translations (`services/translation/cache.ts`) and record `cache_hit`.
- Expose `repairApplied` in parser result metadata for telemetry/dashboards.

### Client
- Apply run/sub-state model to proofread & quality hooks (`useProofreadAgent`, `useQualityAgent`), mapping stage/chunk info into consistent recovery badges.
- Timeline cards and Sidebar sections show `completed/failed/retrying` counts, retry countdowns, and recovering badges across all stages.

### Optimization
- Trim prompts via ID references (e.g. `STYLE:sg:123`), reduce overlap to 1–2 sentences, raise translation worker concurrency (4–8) and run proofread subfeatures in parallel.
- Stand up KPI dashboard for latency (P50/P90), retry-rate (reason), token deltas, cache hit rate.
- Design adaptive chunking (target 700–900 chars with 1-sentence overlap) and detection→revision two-pass flow; stage rollout behind feature flag and apply consistently to translation/proofread/quality.
- Prepare shared retry orchestration that enforces pagination, evidence range mode, and token down-shift across translation/proofread/quality agents.

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
