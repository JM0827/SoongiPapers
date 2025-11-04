# TODO: GPT-5 Translation Pipeline Follow-ups

## Schema

- [x] Draft deliberation schema: add `score` to `required` (translationDraftAgent.ts)
- [ ] JSON Schema lint/test: ensure `required` & `additionalProperties:false` enforced for all Responses schemas

## Guard / Flow

- [x] Block pipeline when `draftResult.meta.truncated === true`
- [x] Ensure truncated meta surfaces in UI/logs (mark Draft as failed)
- [ ] Draft coverage guard: gpt-5-mini validation + per-segment rerun pipeline
- [ ] Revise stage truncation handling: segment split + retry mirroring Draft
- [ ] Implement coverage-based auto retry loop (coverageRatio threshold)
- [ ] Unify logging toggles across translation/proofreading/quality pipelines (env flag vs spec debugLogging)
- [ ] Define response v2 schema (range-based evidence, compact keys) and migrate translation/proofreading agents
  - [x] Translation draft/revise workers emit v2 envelopes over NDJSON stream (`translationStream`)
  - [x] Proofreading agent migration to v2 envelopes (stream + storage) — server emits tier summaries + v2 items, storage updated with tier metrics, UI now surfaces counters
  - [ ] Normalize shared parser so non-stream callers can request v2 payloads
- [ ] Implement pagination (`has_more`/`next_cursor`) and token down-shift retry strategy across agents
- [ ] Spec adaptive chunking + detection→revision dual-pass; stage rollout plan

### Proofread RFC v2.0 Phase A (IDs/Protocol)
- [x] POST → SSE 식별자 계층 통합 (`proofreading_id`, `run_id` 전파)
- [x] Proofread events `type:"items"` + v2 page envelope 통일
- [x] Truncation 강제 pagination (`has_more=true`, server cursor 생성)
- [x] 모델 response_format을 Payload-L v2로 축소하고 서버에서 리치 메타 합성
- [x] Heartbeat 3–5s + SSE 1회 재시도 → 폴백 경로 정비 (stream meta 저장 포함)
- [x] UI 상태머신 정비 (sub-error=recovering, dedupe key, 자동 이어받기)
- [x] Zero-item run complete 보장 + RFC v2 NDJSON 스냅샷 테스트 추가

## Segmentation / Tokens

- [x] Reduce `DEFAULT_MAX_SEGMENT_LENGTH` (e.g., 1600) and consider smarter chunking
- [x] Re-evaluate Revise/Synthesis max token caps after segmentation change
- [x] Verify `callStageLLM` stage models/parameters align with GPT-5 (`SEQUENTIAL_*` ENV, verbosity/effort support)
- [ ] Tune chunk overlap + segmentation policy per content type; document env knobs
- [ ] Adaptive candidateCount heuristics (validate 1-candidate fallback effectiveness)

## Observability

- [x] Extend `recordTokenUsage` to include meta (verbosity, effort, max tokens, retry, truncated, fallback)
- [ ] Add dashboard/alert for truncated or repeated token cap expansions
- [ ] Surface coverageRatio, retryCount, truncation metrics in monitoring
  - [~] Proofread stream counters는 UI/로그 + Postgres(`proofread_stream_metrics`)에 수집됨 — 대시보드/알림 연동 남음

## Config / Docs

- [x] Update staging `.env` (e.g., server/.env.example_gpt5) with GPT-5 defaults
- [ ] Document re-run procedure when truncated occurs (chunk split → Draft rerun)
- [ ] Document Synthesis deprecation + rollout plan
