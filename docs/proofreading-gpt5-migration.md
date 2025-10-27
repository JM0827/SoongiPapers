# GPT-5 Responses Migration Plan (Proofreading First, Full Stack Roadmap)

## 1. Current Architecture Snapshot
- **Agents** (`server/agents/**`): translation draft/revise, proofreading, micro-check, etc., currently rely on `OpenAI.chat.completions.create` with per-stage models (mostly GPT-4 variants).
- **Proofreading** (focus of Phase 1): `proofreadingAgent.ts` + `genericWorker.ts` call GPT-4o-mini via Chat Completions, using prompts defined in `proofreading.spec.json`.
- **Routes** (`server/routes/*.ts`): each stage exposes HTTP endpoints that trigger the corresponding agent. Token usage is recorded via `recordTokenUsage`.

## 2. Responses API-Only Direction
We are standardizing on GPT-5 via the **Responses API** across the entire application (translation → micro-check → proofreading → evaluation). GPT-4 will only be retained as an emergency rollback target, but not used in normal operation. Proofreading migration remains Phase 1 but all architecture decisions must support future GPT-5 adoption by other agents.

Key Responses API traits:
- Models: `gpt-5-pro`, `gpt-5.1-mini` (and successors) — **only** available via `client.responses.create`.
- Params: `max_output_tokens`, `response_format` (JSON schema), tool-call metadata. Legacy knobs (`temperature`, `top_p`, `max_tokens`) are ignored.
- Output: `response.output[]` content blocks + `response.usage.total_tokens`. Structured tool calls replace legacy function-calling semantics.

## 3. Phase Plan
1. **Phase 0 – Plumbing**
   - Introduce shared config module (`server/config/proofreadDefaults.ts` → generalize to `modelDefaults.ts`) describing GPT-5 primary/fallback models, `max_output_tokens`, worker clamps, failure thresholds.
   - Create shared schema utilities (`schema.ts`) for JSON response validation.
   - Wrap OpenAI client usage in a `responsesClient` helper so every agent can call the Responses API consistently (handles sanitization, retries, usage logging).
2. **Phase 1 – Proofreading GPT-5** *(current document focus)*
   - Convert Proofreading pipeline to GPT-5/Responses API, implementing sanitization, retries, fallback to `gpt-5.1-mini` as detailed below.
3. **Phase 2 – Translation Agents**
   - Draft, Revise, Micro-check, evaluation routes adopt the same Responses client wrapper. Prompts updated to emphasize JSON schema compliance; chunk sizes and concurrency auto-tuned for GPT-5 cost.
4. **Phase 3 – Legacy Removal**
   - Remove Chat Completions usage entirely from the codebase. `PROOFREAD_GPT5_ENABLED` evolves into a global `GPT5_RESPONSES_ENABLED` flag controlling whole-app rollout.

## 4. Proofreading Migration (Detailed)
### 4.1 Config & Feature Flags
- `server/config/modelDefaults.ts` exports:
  - `DEFAULT_PROOFREAD_MODEL` (env `PROOFREAD_MODEL`, default `gpt-5-pro`).
  - `FALLBACK_PROOFREAD_MODEL` (`PROOFREAD_MODEL_FALLBACK`, default `gpt-5.1-mini`).
  - Tunables: `PROOFREAD_MAX_OUTPUT_TOKENS` (default 900), `PROOFREAD_MAX_WORKERS` (default 3), `PROOFREAD_FAIL_THRESHOLD_PERCENT` (default 25), `PROOFREAD_FAIL_CRITICAL_KEYS` (JSON list, default `["grammar_spelling_punct","style_register_consistency"]`).
  - Optional allowlist `PROOFREAD_MODEL_ALLOWLIST` extends the base `["gpt-5-pro","gpt-5.1-mini","gpt-4o-mini"]` set.
- Feature flag `PROOFREAD_GPT5_ENABLED` (with optional project allowlist). Later phases will generalize this to a global `GPT5_RESPONSES_ENABLED` controlling other agents.

### 4.2 Responses Client Wrapper
- Introduce `server/services/openai/responsesClient.ts`:
  - Single OpenAI SDK instance, method `callResponses({ model, input, jsonSchema, maxOutputTokens, metadata })`.
  - Handles retries/backoff, fallback to `FALLBACK_PROOFREAD_MODEL`, logging, and sanitization.
  - Used initially by Proofreading but designed so translation/evaluation agents can adopt it in later phases.

### 4.3 JSON Schema & Validation
- `server/agents/proofreading/schema.ts` exports:
  - Zod `IssueItemSchema` (for runtime validation).
  - `ISSUE_ITEM_JSON_SCHEMA` via `zod-to-json-schema` (cached at module load).
- `runGenericWorker` validates GPT-5 outputs against Zod before returning. Failures trigger retries/fallback.

### 4.4 Retry & Fallback Policy
Per subfeature chunk:
1. Call `gpt-5-pro`. On failure (API error or schema violation) retry once with exponential backoff (500 ms → 1 s → 2 s → 4 s cap).
2. If still failing, switch to `gpt-5.1-mini` and retry once.
3. After fallback failure, mark the chunk failed, continue with other chunks. Aggregated failure criteria (see 4.6) determine job status.

### 4.5 Logging & Usage
- Structured log per attempt: `{ subfeature, chunkId, model, attempt, durationMs, totalTokens, responsesApi: true, status, failureReason? }`.
- `recordTokenUsage` accepts `total_tokens`; when no split is provided, log `prompt_tokens = total_tokens`, `completion_tokens = 0`, and attach metadata `{ responses_api: true }`.

### 4.6 Failure Evaluation
- Job fails only if BOTH conditions hold:
  1. Failed chunks ≥ `PROOFREAD_FAIL_THRESHOLD_PERCENT` (default 25%).
  2. Any subfeature listed in `PROOFREAD_FAIL_CRITICAL_KEYS` fails two consecutive attempts (primary + fallback).
- Configurable via env—engineers can override thresholds per deployment.

### 4.7 Data Sanitization
- `sanitizeProofreadPayload` applies:
  - Regex masks for emails, phone numbers, national IDs, plus any custom regex list from `PROOFREAD_PII_REGEXES` (JSON array).
  - Hash-based anonymization of project/user names (SHA-256 truncated to 8 chars).
  - Guard excerpts normalized (whitespace collapsed) and truncated to ≤1000 chars.
  - Minimal metadata only; no raw tenant IDs exit the boundary.
- Security architect approval required before enabling GPT-5 globally.

### 4.8 Runtime Auto-Tuning
When `PROOFREAD_GPT5_ENABLED=true`:
- `maxWorkers = min(spec.maxWorkers, PROOFREAD_MAX_WORKERS || 3)`.
- `quickChunkSize = max(2, spec.quickChunkSize - 1)` and `deepChunkSize = max(1, spec.deepChunkSize - 1)` unless the chunked source length < 800 chars (short docs keep original sizes). Length calculation is based on UTF-16 code units after sanitization.
- Flag off ⇒ use spec-defined values.

### 4.9 Testing
- Unit tests mock the Responses client, verifying JSON schema enforcement, retry/fallback transitions, logging payloads.
- Integration tests in `server/agents/proofreading/__tests__` run the full pipeline with stubbed responses.
- Staging smoke script executes a proofread job nightly on GPT-5; alert if JSON failure rate >20% or latency exceeds threshold.

## 5. Risk Assessment & Mitigations
| Risk | Impact | Mitigation |
| --- | --- | --- |
| Cost/latency spike | GPT-5 tokens expensive | Auto-tune workers/chunk sizes; per-run token logging; throttle concurrency |
| JSON schema drift | GPT-5 may return prose | Strict schema, retries, fallback to `gpt-5.1-mini` |
| SDK incompatibility | Responses API changes | Pin OpenAI SDK version; single wrapper for easy updates |
| Data exposure | Guard context contains PII | Sanitization helper + security review |
| Rollback difficulty | Need fast revert | Feature flag + env-driven models for instant rollback |

## 6. Roadmap for Other Agents
- After Proofreading stabilizes, reuse the Responses client helper + sanitization policy for translation draft, revise, micro-check, evaluation, and chat orchestration.
- Each agent gets its own JSON schema and fallback logic but follows the same GPT-5 model defaults and logging conventions.
- Eventually retire Chat Completions code entirely; `GPT5_RESPONSES_ENABLED` flag governs the whole application.

## 7. Open Decisions
1. Security architect to confirm whether additional masking rules are required.
2. Ops/product to identify tenants (if any) that must stay on GPT-4 for compliance reasons; if so, extend allowlists accordingly.
3. Finalize critical subfeature list and failure thresholds before rollout.

*Document owner:* Architecture team. All future updates tracked via PR.
