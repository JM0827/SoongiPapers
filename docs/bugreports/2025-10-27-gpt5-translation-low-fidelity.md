# Bug Report: GPT-5 Translation V2 Low Fidelity

## Summary

First GPT-5 translation run completed but yielded Fidelity score 54 (target ≥ 90). Output missing large portions of the mid/late sections despite pipeline success status.

## Timeline / Logs

- Draft stage: multiple retries hit `openai_response_incomplete (max_output_tokens)`; truncated flag true.
- Deliberation: schema error (`analysis` items missing required `score` field) → fallback to default candidate.
- Revise stage: repeated `max_output_tokens` truncation; fallback mini model completed but truncated segments passed through.
- Synthesis: succeeded but input already missing segments.
- Profile: also hit token cap at least once.

## Root Causes (Current Hypothesis)

1. Chunk size too large; segments exceeded practical token budget → truncated responses.
2. Draft truncated flag not enforced; pipeline progressed even when Draft was incomplete.
3. Deliberation schema missing `score` in `required` → comparison step skipped.
4. Observability didn't flag truncated segments prominently.

## Impact

- Missing mid/late sections → Fidelity 54 (should be ≥ 90).
- Potentially repeated work/time due to manual QA.

## Immediate Workarounds

- Manually rerun Draft after chunking text smaller, then proceed to Revise/Synthesis.
- Update segmentation or split long segments from the source.

## Proposed Fixes (see docs/gpt-5번역오류개선.md)

1. Add `score` to deliberation schema `required` list.
2. Block pipeline when Draft meta indicates `truncated = true`.
3. Reduce max segment length (e.g., to ≤ 1,600 chars) and keep `max_output_tokens` cap high (up to 6,400).
4. Extend logging/observability to surface truncated events.
5. Ensure staging `.env`/config include GPT-5 defaults (`VERBOSITY`, `REASONING_EFFORT`, `MAX_OUTPUT_TOKENS`) for Draft/Revise/Synthesis so schema/tuning stay aligned.

## Status

- Documented in `docs/gpt-5번역오류개선.md`.
- Implementation pending (next session).
