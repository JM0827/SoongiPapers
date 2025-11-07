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

## 2025-11-05 — Step 1 Audit Notes *(completed)*
- `useTranslationAgent` currently opens an SSE stream per job but simultaneously keeps a 4s `api.getJob` polling loop alive; polling stops only when terminal status or finalization completes.
- Summary hydration happens on every stream mount and again on stream errors; there is no guard to skip once streaming, leading to redundant `/translations/summary` hits.
- Reconnect logic retries up to 5 times with 1–5s flat delay and immediately kicks job polling + summary refresh while waiting.
- Stream lifecycle depends on `translation.status` (`running`/`queued` etc.), so status thrash (e.g., `running` ↔ `recovering`) can prematurely trigger cleanup.
- No explicit `connectionState`; multiple refs (`streamAbortRef`, `streamRetryTimeoutRef`, `streamFailureCountRef`) make it easy to double-open when React re-renders quickly.
- Cursor queue drains immediately on `items` events but does not coordinate with connection health, making it hard to pause fetches during reconnect/backoff windows.

#### Step 1.1 — API Contract Hardening *(in progress)*
- `/api/pipeline/translate`는 저장된 원문 파일 식별자(`originDocumentId`)를 필수 입력으로 삼고, inline `originalText`는 과거 호환용으로만 남긴다. HTTP 라우트는 ID/메타만 큐에 전달하고, 실제 세그먼트 생성·토큰 예산 계산은 번역 워커에서 수행한다.
- 클라이언트는 `/api/projects/:projectId/origin` 또는 `originPrep.upload.originFileId`를 사용해 최신 원문 ID를 확보한 뒤 번역을 개시한다.
- 번역 요약, Proofread Editor, `/translations/:runId/items` REST 응답 모두 `canonicalCacheState` 필드를 노출한다. 클라이언트는 상태가 `missing`일 때 `POST /api/projects/:projectId/translations/:jobId/canonical/warmup`을 한 번 호출해 lazy warmup 큐(`translation_canonical_warmup`)를 트리거하고, 상태가 `warming`이면 SSE/요약 갱신을 기다린다.

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

## 2025-11-05 — Step 2 Summary Notes *(completed)*
- Added `translationSummaryState` to persist stage timeline, pagination, segment, and follow-up metrics via `stream_run_metrics` extras; stage/page events now update the store before SSE dispatch.
- Refactored `translationSummary` to consume the enriched extras, align percent logic with micro-check completion, and surface per-stage timestamps from SSE data.
- Hardened `recordTranslationMetricsSnapshot` to merge prior values so partial updates (stages, pagination) no longer wipe tokens or connection counters.
- New unit tests cover percent clamping and stage timeline hydration (`server/services/translation/__tests__/translationSummary.test.ts`).
- Validation: `npx tsc --project server/tsconfig.json --noEmit` ✅. `npm test --prefix server` ❌ — sandbox blocks `tsx` IPC socket (`EPERM /tmp/tsx-...`); rerun outside constrained environment.

## 2025-11-05 — Step 3 Stream Health Notes *(completed)*
- Translation stream route now disables compression/buffering, flushes headers, writes an initial `{}` chunk, and stretches heartbeat cadence to 10–12s (`server/routes/translationStream.ts`).
- Reconnect attempts are tracked server-side; crossing 10 consecutive failures logs a warning and stamps metrics extras so summaries surface a manual-retry state.
- Client hook (`useTranslationAgent.ts`) reacts to the new resilience flag by parking the run in `recovering`, clearing auto-retry, and messaging the user-friendly retry hint.
- Vite dev proxy forces `Accept-Encoding: identity` on `/api` to avoid reintroducing gzip buffering during SSE (`web/vite.config.ts`).
- Validation: `npx tsc --project server/tsconfig.json --noEmit`, `npx tsc --project web/tsconfig.json --noEmit` ✅. End-to-end server tests still blocked by sandbox `tsx` IPC restriction.
- Translation metrics upserts must always pass `run_type = 'translate'` so `stream_run_metrics` cleanly separates translation runs from other workflows.

## Step 4 — Segmentation, Hashing, Tokens, and Summary Redesign

### Goals
- Replace the legacy segmentation + paging heuristics with a canonical segmentation engine that emits stable BLAKE3 hashes and overlap-aware metadata.
- Store segment definitions once and reuse them across draft/revise/micro-check stages, resume flows, and downstream analytics.
- Drive SSE pagination, summaries, and metrics from hash-indexed data to remove duplicate/omitted pages and eliminate percent/progress drift.
- Apply a unified dynamic token budget policy (ceil(sourceTokens × 1.6), clamped 120–800) everywhere the pipeline calls OpenAI, ensuring predictable cost envelopes and fewer truncations.
- Deliver thorough regression coverage and documentation so the new pipeline can ship without feature flags.

### Step 4.1 — Canonical Segmentation Design*(M0 complete)*
- Create a dedicated module `server/services/translation/segmentationEngine.ts` responsible for:
  - Normalizing origin text (Unicode normalization, whitespace trimming, paragraph boundary detection).
- Detecting sentence boundaries via `Intl.Segmenter` (KO/EN) with punctuation/line-break fallback when ICU is unavailable. Splitter direction defaults to project `sourceLanguage`/`targetLanguage` and per-segment heuristics (Hangul ≥60 % → KO, Latin ≥60 % → EN).
  - Applying token-based overlap length (default 50 tokens, configurable 40–60) between segments when paragraph mode is active. Character-based overlap is deprecated.
  - Computing a deterministic BLAKE3 hash for each segment via `hash-wasm` (`await createBLAKE3()` cached once), avoiding native dependencies and working in CJS/ESM runtimes.
  - Returning `CanonicalSegment` objects with `{ id, hash, paragraphIndex, startOffset, endOffset, overlapPrev, overlapNext, tokenEstimate, overlapTokens }`.
  - Document the segmentation contract: every downstream stage (draft, revise, micro-check) must treat the hash as the primary identity; `segmentId` remains for human readability and to coordinate with existing Mongo documents until the new schema fully replaces it.
- Define configuration knobs:
  - `SEGMENTATION_OVERLAP_TOKENS` (default 50, clamp 40–60) for paragraph mode.
  - `SEGMENTATION_MODE` (`paragraph` | `sentence`) per document; paragraph mode prioritises sentence boundaries when constructing segments.
  - `SEGMENTATION_SENTENCE_MAX_TOKENS` (default 480). Values below 200 or above 800 are ignored and replaced with the default (log a warning). Used to cap long sentences before forced splits.
- Draft a reference document of corner cases (leading/trailing whitespace, multiple blank lines, mixed-language sentences) and expected outputs.

### Step 4.2 — Persistent Segment Metadata*(M1 complete)*
- Introduce a Postgres table `translation_segment_meta` with columns:
  - `run_id` (PK component), `segment_id` (PK component), `hash`, `segment_order` (int), `paragraph_index` (int), `sentence_index` (int | null), `start_offset`, `end_offset`, `overlap_prev` (bool), `overlap_next` (bool), `overlap_tokens` (int), `token_estimate` (int), `token_budget` (int), `created_at`.
  - `segment_order` is the zero-based position of the canonical segment within the run; pipeline stages (draft/revise/micro-check) are inferred elsewhere.
  - Later revisions can include `language`, `version` to track re-segmentation events.
  - All server code now reads the Postgres connection from `process.env.DATABASE_URL`; legacy `PG_*` env access has been removed.
- Recommended DDL scaffold:

  ```sql
  CREATE TABLE translation_segment_meta (
    run_id TEXT NOT NULL,
    segment_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    segment_order INT NOT NULL,
    paragraph_index INT NOT NULL,
    sentence_index INT,
    start_offset INT NOT NULL,
    end_offset INT NOT NULL,
    overlap_prev BOOLEAN NOT NULL DEFAULT false,
    overlap_next BOOLEAN NOT NULL DEFAULT false,
    overlap_tokens INT NOT NULL DEFAULT 0,
    token_estimate INT NOT NULL,
    token_budget INT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, segment_id),
    UNIQUE (run_id, hash)
  );

  CREATE INDEX idx_tsm_run_hash ON translation_segment_meta (run_id, hash);
  ```

  Insert logic must always supply `token_estimate` and `token_budget`; these columns are non-null by design.
- Populate the table when a translation run starts. Treat the table as the single source of truth for segment definitions.
- Remove ad-hoc segment metadata from `translationPages` and stream extras; keep only run-level aggregates (e.g., total segments, overlap segment count) in `stream_run_metrics.extras` under `segments: { version, total, overlaps }`.
- Provide helper functions `loadCanonicalSegments(runId)` and `ensureCanonicalSegments(projectId, jobId)` that either fetch the stored rows or compute + persist if missing. Because we are mid-development, we can assume a clean slate (no legacy compatibility shim).

### Step 4.3 — Hash-First Paging and SSE Rewire*(M2 complete)*
- Update `translationPages` to accept `CanonicalSegment[]` and stage results, constructing NDJSON envelopes keyed by `hash` instead of synthetic `chunk_id` alone.
  - Cursor format: `${stage}:${hash}` for continuation; final page emits empty `next_cursor`. Payloads carry `segment_hashes`, `validatorFlags`, and `autoFixesApplied` for downstream QA.
  - Deduplicate on `<stage, hash>`; if a segment is replayed (resume/backoff), the reducer overwrites by hash.
- Extend SSE payloads (`TranslationStageEvent`, `TranslationPageEvent`) with `segment_hashes` arrays so the client can track progress per hash.
- Align REST pagination `/translations/:runId/items` to the same hash-based cursor parameters. This ensures resume flows and QA tools see the same ordering the SSE stream emits.
- Enforce hash-first dedupe end-to-end: server reducers (`translationPages`, cursor stores), SSE, REST, and client (`dedupeAgentPages`, `useTranslationAgent`) all store processed/pending cursors as `<stage, hash>` to eliminate partial rollouts.
- Payload shapes for parity:
  - `segment_hashes`: `string[]`, maintaining emitted segment order.
  - `validatorFlags`: JSON object `{ [validatorId: string]: string[] }`; omit the key when the array would otherwise be empty.
  - `autoFixesApplied`: `string[]` containing applied auto-fix identifiers.

### Step 4.4 — Unified Token Budget Policy *(M3 complete)*
  - *M3-2 (2025-11-06)* — Draft/Revise/Micro-check now use the shared budget helper end-to-end. Length retries follow primary → downshift (×0.7) → segment split flow, and stage metrics capture intended vs. actual token totals (including micro-check clamps). Unit tests cover incomplete→downshift→segment retry, plus segmentation-driven fallback cases.
  - Implement a shared helper `calculateTokenBudget({ originSegments, mode, direction, isDeepRevise })` that returns `cap = clamp( ceil(src_tokens × 1.6), min=120, max=800 )` with language-direction adjustments (KO→EN ×1.2, EN→KO ×0.85). Honour `REVISION_DEEP_MAX_CAP` (default 1200) only for deep-revise scenarios.
  - `src_tokens` derives from `tokenEstimate` stored on canonical segments; fall back to `ceil(char_count / 4)` when the estimate is missing. Persist both `token_estimate` and the computed `token_budget` to `translation_segment_meta` so all stages see consistent values.
  - Draft, Revise, Micro-check, and any retry helpers must consume the same util. Remove individual stage-specific env caps other than the deep-revise override. Micro-check invocations clamp to `MICROCHECK_TOKENS_MIN/MAX` (defaults 80/120) before calling the LLM.
  - When recording metrics, push both intended (`tokens.intended`) and actual (`tokens.actual`) token totals into `stream_run_metrics.extras`. Target ratio: intended/actual ≈ 0.6–0.85 under normal conditions.
  - Error handling for `stop_reason="length"` captures the segment hash and the current budget; logs/metrics should make it easy to spot repeated length failures.
  - Formalise length retries: first `length` failure scales the cap ×0.7; a subsequent `length` splits on sentence boundaries (or halves) and re-applies the util per fragment. Temporary suffixes (e.g., `hash#a`) exist only within the retry stack—canonical storage keeps the original hash untouched.
  - QA guardrails: `stop_reason="length"` < 3% overall, average retry count ≤ 1.3. Capture these figures during manual verification and document in release notes.

### Step 4.5 — Summary & Metrics Rebuild *(completed 2025-11-06)*
- **Summary service**: `getTranslationRunSummary` now reads canonical totals directly from `translation_segment_meta`, exposes hash-aware progress (`progress.hashes` + `microcheckCompleted`), and clamps the percentage to 99 % until the micro-check hash count matches the canonical total. Stage timelines still respect extras values but fall back to canonical run timestamps when needed.
- **Extras persistence**: `updateSegmentsMetrics`/`updatePaginationMetrics` only record hash-level aggregates (`version`, `totalHashes`, `processedHashes`, `cursorHash`). REST/SSE pagination no longer serialises raw page payloads into `stream_run_metrics.extras`.
- **SSE completion snapshot**: `emitTranslationComplete` now calls `recordTranslationMetricsSnapshot` with the final token totals, canonical segment metrics, and any cost/extras so `/translations/summary` stays authoritative even if the SSE client reconnects late.
- **QA / tests**: `npx tsc -p server/tsconfig.json --noEmit` passes. The sandboxed `npm test --prefix server` run (translation summary suite) fails because `tsx` cannot install the `@esbuild/linux-x64` optional binary; see docs/QA/translation-proofread-retry-checklist.md for the manual verification steps we still need to run once CI/unrestricted shells are available.

### Step 4.6 — Testing & QA Strategy
- Canonical segmentation now runs in cooperative chunks: `segmentCanonicalText` yields to the event loop every ~75 segments (configurable via `CANONICAL_SEGMENT_YIELD_INTERVAL`) and `persistSegments` pauses between INSERT batches. When `CANONICAL_SEGMENT_WORKER` is enabled the heavy segmentation work executes in a dedicated worker thread (`segmentationWorker.ts`), keeping the BullMQ worker responsive even for multi-thousand segment runs, and `prepareOriginSegmentsForJob` now invokes `ensureCanonicalSegments` up front so the job bootstrap happens off-thread as well. Translation workers also use extended BullMQ `lockDuration`/`stalledInterval` defaults (≥240 s/60 s) so long-running canonical builds no longer appear as stalled jobs.
- **Unit tests**
  - `segmentationEngine.test.ts`: paragraph vs. sentence mode, overlap 40/50/60-token boundaries, hash stability (same input → same hash), long paragraph splits.
  - `translationPages.hashCursor.test.ts`: dedupe, resume, and cursor navigation using `<stage, hash>` keys.
  - `tokenBudget.test.ts`: dynamic clamp logic, regression cases for extremely short or long documents.
  - `useCanonicalWarmup.test.ts`: hook triggers warmup exactly once per `{projectId, jobId}` when `canonicalCacheState === 'missing'`, no-op for `ready/warming`.
- **Integration tests**
  - End-to-end pipeline fixture with long document; verify SSE order, percent progression (monotonic), follow-up counts, intended/actual token ratio per stage, and resume behaviour after simulated disconnect.
  - QA script to fetch `/translations/summary` after each stage and assert matches against persisted `translation_segment_meta` values.
  - Canonical cache warmup flow: hit `/translations/:jobId/canonical/warmup` when cache is empty and ensure lazy job flips `canonicalCacheState` to `ready`. Verify pagination and Proofread Editor endpoints reflect the new state without reloading the stream.
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


## Step 5 — Revise Parallelisation *(planned)*
- Immediately after Step 4 core lands, split Revise work into small segment batches (e.g., 4–6 segments) and process them concurrently within the worker pool.
- Feed Draft output into the Revise queue as soon as each batch is ready to enable pipeline-style streaming and reduce end-to-end latency.
- Reuse the new segment hash + observability metrics (intended vs. actual tokens, stop_reason, batch latency) to monitor the effect and catch ordering issues quickly.
- Success criteria: end-to-end latency drops proportionally to concurrency level, resume flows remain stable, and `stop_reason="length"` stays <3% with average retries ≤1.3.

### Appendix — Open Questions & Follow-Ups
- Do we need to expose segment hashes to the client UI (e.g., for QA tooling)? If so, plan a minimal, secure API to retrieve canonical segments.
- Should we add versioning to the segmentation engine (e.g., `meta_version` column) so future algorithm tweaks can coexist with stored runs?
- Evaluate whether the new token budgeting requires changes to cost tracking (e.g., stream_run_metrics should now include `intended_tokens_out`).
- Decide if we delete the obsolete `translationSegment` retry helpers or keep a thin wrapper that delegates to the new engine.
