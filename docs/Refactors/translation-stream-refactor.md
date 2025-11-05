# Translation Streaming Refactor Plan

## Goal
- Maintain a single SSE connection per translation run.
- Remove redundant summary/job polling while streaming.
- Produce accurate summary metrics (progress, stages, usage).
- Prepare for long-document resilience (resume, pagination).

## Scope & Deliverables

### 1. Client Streaming State Machine (`web/src/hooks/useTranslationAgent.ts`)
- Introduce `connectionState: 'idle' | 'connecting' | 'streaming' | 'backoff'`.
- Hydrate once on tab entry (summary 1x) → open stream → stop all polling.
- On `close`/`error`, start exponential backoff (1s→2s→4s→8s→…≤30s) and reconnect.
- Prevent cleanup on `translation.status` churn; only abort when run ends (`done|failed|cancelled|cancelTranslation`).
- Remove overlapping job polling; when stream is open, all summary/job fetches are disabled.

### 2. Summary Aggregation (`server/services/translationSummary.ts`)
- `segmentsTotal`: value from first segmentation metadata.
- `segmentsProcessed`: micro-check completed segments.
- `percent`: `round(segmentsProcessed / segmentsTotal * 100)` and clamp to 100 only when micro-check done.
- Stage timestamps (`startedAt/completedAt`): capture on runner events (Draft/Revise/Micro-check start/end).
- Ensure follow-up totals/pagination/usage sourced from `stream_run_metrics` + SSE incremental updates.

### 3. Stream Health & Metrics (`server/routes/translationStream.ts`, `server/services/translationStreamMeta.ts`)
- Confirm NDJSON headers: `Content-Type`, `Cache-Control: no-transform`, `Connection: keep-alive`, `Transfer-Encoding: chunked`.
- Disable compression/proxy buffering (nginx, Vite dev proxy).
- Write initial `{}` payload and heartbeat (10–15s) to keep connections alive.
- On every stage/event, upsert `stream_run_metrics` with tokens_in/out, model, cost.
- Enforce reconnect counter limits; after 10 failures notify user + log warning.

### 4. Segmentation & Token Budget (`server/agents/translation/...`)
- Align paragraph segmentation to UI expectation (paragraph-count matched). Use overlap + BLAKE3 chunk hash to avoid duplicates.
- Apply dynamic `max_output_tokens` (ceil(srcTokens × 1.6), min 120, max 800) per stage.
- Emit unit tests for segmentation edge cases.
- Persist segment hashes/boundaries with the run so resumes reuse identical splits instead of recomputing.
- Ensure REST stream/pagination dedupe logic accounts for overlapping chunks to avoid duplicate pages.
- Extend token budget guardrails to retry paths (segmentRetryHelpers, runResponsesWithRetry) for consistency.
- Expand regression coverage to long paragraph chunks (overlap correctness, hash stability) and cross-check summary percent.

### 5. Observability & QA
- Key logs: `[TranslationSSE] open/dispatch/close`, `[TranslationSummary] build`, reconnect counters.
- QA checklist:
  - `/translations/stream` single connection, summary/job fetch ≤ 2 calls per run.
  - `reconnectAttempts` ≤ 1 under normal conditions.
  - Stage progress monotonic; percent reaches 100% only when micro-check complete.
  - Follow-up toast & header badge keep consistent counts; dismiss state per project preserved.

## Implementation Sequence
1. Client SSE state machine refactor (remove redundant polling, add backoff).
2. Server summary/stage timestamp updates & metrics upsert.
3. Segmentation/token budget adjustments.
4. QA verification (short/long docs) & logging review.
5. Documentation update + rollout checklist.

## Owners & Timeline
- **Owner:** Translation Platform (BE/FE)
- **ETA:** 1 week (dev) + 2 days verification.

## 2025-11-05 — Step 1 Audit Notes
- `useTranslationAgent` currently opens an SSE stream per job but simultaneously keeps a 4s `api.getJob` polling loop alive; polling stops only when terminal status or finalization completes.
- Summary hydration happens on every stream mount and again on stream errors; there is no guard to skip once streaming, leading to redundant `/translations/summary` hits.
- Reconnect logic retries up to 5 times with 1–5s flat delay and immediately kicks job polling + summary refresh while waiting.
- Stream lifecycle depends on `translation.status` (`running`/`queued` etc.), so status thrash (e.g., `running` ↔ `recovering`) can prematurely trigger cleanup.
- No explicit `connectionState`; multiple refs (`streamAbortRef`, `streamRetryTimeoutRef`, `streamFailureCountRef`) make it easy to double-open when React re-renders quickly.
- Cursor queue drains immediately on `items` events but does not coordinate with connection health, making it hard to pause fetches during reconnect/backoff windows.

### Step 1 Connection State Machine Design
- Maintain `connectionState` via `useState`/`useRef` pair (`idle → connecting → streaming → backoff`), defaulting to `idle` and resetting there on unmount or terminal cleanup.
- `startStream(jobId)` will: skip if credentials missing or a live stream exists, set `connecting`, run a single hydration (`refreshSummary`) guarded by `hydrationEpochRef`, then invoke `api.streamTranslation`. Mark `streaming` after the first SSE payload, reset failure counters, and cancel any outstanding summary/poll timers.
- `stopStream(reason)` centralizes teardown: abort through `streamRef`, clear `reconnectTimerRef`/`pollingTimerRef`, zero the failure counter, and revert to `idle` unless we're immediately scheduling backoff.
- `scheduleReconnect()` bumps `reconnectAttemptRef`, flips state to `backoff`, computes `delay = min(1000 * 2^(attempt - 1), 30000)`, queues `reconnectTimerRef`, and performs one guarded hydration during the wait. Only after the delay do we retry `startStream`; if attempts ≥ 3 we schedule an extra summary refresh via `pollingTimerRef` to keep UI state fresh without re-enabling continuous polling.
- `refreshSummary` no-ops when `connectionStateRef.current === 'streaming'` and records a per-attempt hydration token so reconnect loops do not spam the endpoint.
- The stream lifecycle effect now depends on `[projectId, translation.jobId]` and ignores transient status flips. A lightweight watcher effect listens for terminal statuses (`done|failed|cancelled`) to invoke `stopStream()`.

### Step 1 Implementation Progress — 2025-11-05
- Refactored `useTranslationAgent` to expose `connectionState` and gate all hydration/stream setup through `startStream`/`stopStream` helpers; SSE bootstrap hydrates exactly once per attempt and promotes to `streaming` on the first payload.
- Removed legacy `/jobs/:id` polling loop and associated refs; continuous polling is now disabled while SSE is alive and a single backoff summary kicks in only after ≥3 failures.
- Added exponential backoff reconnect (`1s → 2s → … ≤30s`) driven by `scheduleBackoffReconnect`, sharing timers via `reconnectTimerRef`/`pollingTimerRef` and coalescing duplicate reconnect attempts.
- Stream handlers (`handleStreamEvent`) report health via `markStreamHealthy`, funnel cursor work through guarded queues, and rely on SSE termination (`end`, `complete`, `error`) to trigger cleanup/backoff rather than toggling on `translation.status`.
- Hook return and lifecycle effects now stop streams solely when runs hit terminal states or the component unmounts; transient `running ↔ recovering` churn no longer tears down the connection.

### Step 1 Validation Notes
- `npx tsc --project web/tsconfig.json --noEmit` ✅ (sanity check for TS errors post-refactor).
- `npm test --prefix web` ❌ — blocked by sandbox `@rollup/rollup-linux-x64-gnu` optional dep (npm cli bug); rerun once deps can be reinstalled outside sandbox.
- `npm run build --prefix web` ✅(tsc) / ❌(vite) — TypeScript stage clears after hook fixes; Vite build still blocked by the same missing optional Rollup binary in sandbox.

## 2025-11-05 — Step 2 Summary Notes
- Added `translationSummaryState` to persist stage timeline, pagination, segment, and follow-up metrics via `stream_run_metrics` extras; stage/page events now update the store before SSE dispatch.
- Refactored `translationSummary` to consume the enriched extras, align percent logic with micro-check completion, and surface per-stage timestamps from SSE data.
- Hardened `recordTranslationMetricsSnapshot` to merge prior values so partial updates (stages, pagination) no longer wipe tokens or connection counters.
- New unit tests cover percent clamping and stage timeline hydration (`server/services/translation/__tests__/translationSummary.test.ts`).
- Validation: `npx tsc --project server/tsconfig.json --noEmit` ✅. `npm test --prefix server` ❌ — sandbox blocks `tsx` IPC socket (`EPERM /tmp/tsx-...`); rerun outside constrained environment.

## 2025-11-05 — Step 3 Stream Health Notes
- Translation stream route now disables compression/buffering, flushes headers, writes an initial `{}` chunk, and stretches heartbeat cadence to 10–12s (`server/routes/translationStream.ts`).
- Reconnect attempts are tracked server-side; crossing 10 consecutive failures logs a warning and stamps metrics extras so summaries surface a manual-retry state.
- Client hook (`useTranslationAgent.ts`) reacts to the new resilience flag by parking the run in `recovering`, clearing auto-retry, and messaging the user-friendly retry hint.
- Vite dev proxy forces `Accept-Encoding: identity` on `/api` to avoid reintroducing gzip buffering during SSE (`web/vite.config.ts`).
- Validation: `npx tsc --project server/tsconfig.json --noEmit`, `npx tsc --project web/tsconfig.json --noEmit` ✅. End-to-end server tests still blocked by sandbox `tsx` IPC restriction.

## Step 4 — Segmentation, Hashing, Tokens, and Summary Redesign

### Goals
- Replace the legacy segmentation + paging heuristics with a canonical segmentation engine that emits stable BLAKE3 hashes and overlap-aware metadata.
- Store segment definitions once and reuse them across draft/revise/micro-check stages, resume flows, and downstream analytics.
- Drive SSE pagination, summaries, and metrics from hash-indexed data to remove duplicate/omitted pages and eliminate percent/progress drift.
- Apply a unified dynamic token budget policy (ceil(sourceTokens × 1.6), clamped 120–800) everywhere the pipeline calls OpenAI, ensuring predictable cost envelopes and fewer truncations.
- Deliver thorough regression coverage and documentation so the new pipeline can ship without feature flags.

### Step 4.1 — Canonical Segmentation Design
- Create a dedicated module `server/services/translation/segmentationEngine.ts` responsible for:
  - Normalizing origin text (Unicode normalization, whitespace trimming, paragraph boundary detection).
  - Applying configurable overlap length (default 120 UTF-16 chars) between segments when paragraph mode is active.
  - Computing a deterministic BLAKE3 hash for each segment using the `blake3-wasm` package (pure JS + WASM fallback to avoid native build failures).
  - Returning `CanonicalSegment` objects with `{ id, hash, paragraphIndex, startOffset, endOffset, overlapPrev, overlapNext, tokenEstimate }`.
- Document the segmentation contract: every downstream stage must treat the hash as the primary identity; `segmentId` remains for human readability and to coordinate with existing Mongo documents until the new schema fully replaces it.
- Define configuration knobs:
  - `SEGMENTATION_OVERLAP_CHARS` (default 120, clamp 0–240) for paragraph mode.
  - `SEGMENTATION_MAX_PARAGRAPH_CHARS` (default 2_400) to decide when to split long paragraphs.
  - `SEGMENTATION_MODE` (`paragraph` | `sentence`) per document.
- Draft a reference document of corner cases (leading/trailing whitespace, multiple blank lines, mixed-language sentences) and expected outputs.

### Step 4.2 — Persistent Segment Metadata
- Introduce a Postgres table `translation_segment_meta` with columns:
  - `run_id` (PK component), `segment_id` (PK component), `hash`, `stage_order` (int), `paragraph_index` (int), `start_offset`, `end_offset`, `overlap_prev` (bool), `overlap_next` (bool), `token_estimate` (int), `created_at`.
  - Later revisions can include `language`, `version` to track re-segmentation events.
- Populate the table when a translation run starts. Treat the table as the single source of truth for segment definitions.
- Remove ad-hoc segment metadata from `translationPages` and stream extras; keep only run-level aggregates (e.g., total segments, overlap segment count) in `stream_run_metrics.extras` under `segments: { version, total, overlaps }`.
- Provide helper functions `loadCanonicalSegments(runId)` and `ensureCanonicalSegments(projectId, jobId)` that either fetch the stored rows or compute + persist if missing. Because we are mid-development, we can assume a clean slate (no legacy compatibility shim).

### Step 4.3 — Hash-First Paging and SSE Rewire
- Update `translationPages` to accept `CanonicalSegment[]` and stage results, constructing NDJSON envelopes keyed by `hash` instead of synthetic `chunk_id` alone.
  - Cursor format: `${stage}:${hash}` for continuation; final page emits empty `next_cursor`.
  - Deduplicate on `<stage, hash>`; if a segment is replayed (resume/backoff), the reducer overwrites by hash.
- Extend SSE payloads (`TranslationStageEvent`, `TranslationPageEvent`) with `segment_hashes` arrays so the client can track progress per hash.
- Align REST pagination `/translations/:runId/items` to the same hash-based cursor parameters. This ensures resume flows and QA tools see the same ordering the SSE stream emits.
- Update `dedupeAgentPages` and `useTranslationAgent` cursor handling to rely on hash keys; processed/pending cursor sets should store `stage:hash` strings for at-most-once delivery.

### Step 4.4 — Unified Token Budget Policy
- Add `calculateTokenBudget({ originSegments, mode })` to the segmentation module, returning `ceil(sourceTokens × 1.6)` with clamps `[120, 800]`.
  - `sourceTokens` derived from `token_estimate` produced by the segmentation engine; fall back to a chars/4 heuristic if the estimate is missing.
- Draft, revise, length-guard retries, and segment-level fallbacks must consume the same util. Remove environment-based hard caps except as optional overrides (`TRANSLATION_MAX_OUTPUT_TOKENS_CAP` still bounds at 800 by default).
- Record the computed budget in `translation_segment_meta` (column `token_budget`) and propagate to `recordTranslationMetricsSnapshot` so observability dashboards see the intended vs. actual usage.
- Update error handling: when the model responds with length truncation, include the segment hash and budget to simplify debugging.

### Step 4.5 — Summary & Metrics Rebuild
- Refactor `getTranslationRunSummary` to:
  - Pull segment totals and processed counts from `translation_segment_meta` + micro-check result hashes.
  - Compute percent complete via `completedHashes / totalHashes` and clamp to 99 until all micro-check segments report `needsFollowup` resolution.
  - Construct stage timelines using the canonical segments and the new `hash` references to avoid relying on stage progress heuristics.
- Modify `updateSegmentsMetrics`, `updateFollowupMetrics`, and `updatePaginationMetrics` to store hash-level aggregates (counts) but no longer push raw pages into extras.
- Ensure SSE `complete` events call `recordTranslationMetricsSnapshot` with final token totals and `segmentsVersion` so summary hydrations stay authoritative.

### Step 4.6 — Testing & QA Strategy
- **Unit tests**
  - `segmentationEngine.test.ts`: paragraph vs. sentence mode, overlap boundaries, hash stability (same input → same hash), long paragraph splits.
  - `translationPages.hashCursor.test.ts`: dedupe, resume, and cursor navigation using `<stage, hash>` keys.
  - `tokenBudget.test.ts`: dynamic clamp logic, regression cases for extremely short or long documents.
- **Integration tests**
  - End-to-end pipeline fixture with long document; verify SSE order, percent progression, follow-up counts, and resume behaviour after simulated disconnect.
  - QA script to fetch `/translations/summary` after each stage and assert matches against persisted `translation_segment_meta` values.
- **Tooling**
  - Add a CLI script `npm run debug:segments -- --run <id>` to dump canonical segments for manual inspection.
  - Update CI to run segmentation + token tests alongside existing suites.

### Step 4.7 — Rollout Plan
- Because we are pre-PROD, we can deliver the redesign in a single feature branch, but for reviewer sanity split the PR into logical commits:
  1. Segmentation engine + new schema scaffolding.
  2. Hash-based paging + SSE/REST updates.
  3. Token budget unification.
  4. Summary/metrics adjustments and documentation.
  5. Test suites + QA scripts.
- Clearly annotate the migration note: existing development data should be reset (drop old runs) before deploying this branch to staging.
- Document manual QA steps (long doc run, resume after forced disconnect, verify follow-up badge) in the PR template referencing this section.

### Appendix — Open Questions & Follow-Ups
- Do we need to expose segment hashes to the client UI (e.g., for QA tooling)? If so, plan a minimal, secure API to retrieve canonical segments.
- Should we add versioning to the segmentation engine (e.g., `meta_version` column) so future algorithm tweaks can coexist with stored runs?
- Evaluate whether the new token budgeting requires changes to cost tracking (e.g., stream_run_metrics should now include `intended_tokens_out`).
- Decide if we delete the obsolete `translationSegment` retry helpers or keep a thin wrapper that delegates to the new engine.
