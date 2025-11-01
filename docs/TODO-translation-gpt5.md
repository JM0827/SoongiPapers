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
- [ ] Implement pagination (`has_more`/`next_cursor`) and token down-shift retry strategy across agents
- [ ] Spec adaptive chunking + detection→revision dual-pass; stage rollout plan

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

## Config / Docs

- [x] Update staging `.env` (e.g., server/.env.example_gpt5) with GPT-5 defaults
- [ ] Document re-run procedure when truncated occurs (chunk split → Draft rerun)
- [ ] Document Synthesis deprecation + rollout plan
