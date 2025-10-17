# Sequential Translation Pipeline – Implementation Plan (v6.1)

## Objective
Build the ko↔en sequential pipeline described in `docs/sequential-translation-pipeline.md (v6.1)`, retiring legacy triple-pass logic and anchoring all translation work on Project Memory, staged workers, and guard rails.

## Workstream Overview
1. **Database & Schema groundwork** – add Project Memory tables and extend `translation_drafts` to hold per-stage payloads, baselines, and guard metadata.
2. **Shared contracts & configuration** – expose updated types/config in `@bookko/translation-types`, remove triple_pass toggles, and align server consumers with v6.1 shapes.
3. **Stage pipeline core** – implement Literal/Style/Emotion/QA workers, guard evaluation ladder (including sentence-restore helper), baseline caching, and the fail-safe flow.
4. **Project Memory service** – ship `/api/memory/*` endpoints plus background miners to populate/refresh Memory versions.
5. **Synthesis & proofread adjustments** – convert synthesis into a collector, add proofread idempotency (Redis key + Postgres audit), and update guard data feeds.
6. **Frontend touch-ups** – remove multi-pass UI elements, surface sequential status, and ensure proofread tooling consumes final segments only.
7. **Testing & telemetry** – add unit/integration coverage for the new pipeline and wire structured logs/SLO metrics.

## Milestones & Tasks

### 1. Database & Schema groundwork ✅
- Created schemas for `translation_memory`, `translation_memory_versions`, `translation_drafts`, and `proofread_runs`; updated `translationprojects` defaults to lowercase ISO codes.
- Flush/reset script now truncates the new tables; config files reference the sequential schema.
- Backfill script still TODO (to be written closer to rollout once Postgres store is in use).

### 2. Shared contracts & configuration
- Publish the v6.1 TypeScript contract (`ProjectMemory`, `SequentialTranslationConfig`, etc.) from `@bookko/translation-types`.
- Remove legacy `triple_pass` + `dualRun` options from config readers; default `translationMode` to `"sequential"` everywhere.
- Ensure server/web imports resolve to shared types only (no local duplicates).

### 3. Stage pipeline core
- Refactor translation queue into stage jobs (`handleTranslationStageJob`).
- Implement processors for Literal, Style, Emotion, QA stages, persisting outputs into `translation_drafts` with `stage` markers.
- Build utilities:
  - Baseline loader persisting JSON into `translation_drafts.baseline` keyed by source hash.
  - Guard evaluator honoring sentence alignment + entity extraction ladder + romanization policy.
  - Sentence-restore helper (deterministic first, gpt-4o-mini fallback).
- Implement retry ladder + fail-safe (tighten Style/Emotion, fallback to strict Literal, mark `needs_review`).

### 4. Project Memory service
- Implement `/api/memory/init`, `/api/memory/update`, `/api/memory/current` handlers.
- Build background miner job to append new symbols/entities/terms and update style stats on schedule.
- Ensure Memory versions increment atomically and snapshots persist in `translation_memory_versions`.

### 5. Synthesis & proofread adjustments
- Replace legacy synthesis with collector that assembles Emotion outputs into final `TranslationFile`/`TranslationSegment` records.
- Add proofread idempotency (Redis key `proofread:<fileVersion>:<memoryVersion>:<sha256(finalText)>`, Postgres `proofread_runs`).
- Feed guard/baseline data into proofread worker for issue ranking filters.

### 6. Frontend touch-ups
- Remove multi-pass copy/UX references; align status indicators with sequential stages (e.g., “Literal pass”, “Emotion pass”).
- Ensure proofread and preview views consume the final segments and `needs_review` flags.

### 7. Testing & telemetry
- Unit tests: segmentation/context briefs, entity extractor, guard calculator, sentence-restore helper.
- Integration tests: full stage pipeline with mocked LLM responses, retry ladder, fail-safe path, proofread idempotency.
- Observability: structured logs per stage (documentId, segmentIndex, stage, guard flags), stage latency metrics, retry counters, SLO alerts.

## Deliverables
- Updated schema + migrations.
- Sequential stage worker implementation with guards + fail-safe.
- Project Memory API/service + background miner.
- Collector synthesis + proofread idempotency.
- Frontend adjustments and documentation updates.
- Automated tests covering core flows; logging/metrics configuration for ongoing monitoring.

## Dependencies & Tools
- Postgres access for migrations and new tables.
- gpt-4o-mini/gpt-4o availability for baseline, memory, and stage prompts.
- Redis for queue + proofread de-dup keys.
- Existing logging/metrics stack for SLO wiring.

## Risks & Mitigations
- **Guard regressions:** rely on deterministic alignment + Memory lexicon before LLM fallback; surface `needs_review` for manual QA.
- **Cost spikes:** enforce token budgets, reuse ContextBriefs, tighten creative autonomy on retry, log cost summaries.
- **Migration safety:** wrap schema changes in transactional migrations; provide backfill scripts and rollout plan.
- **Throughput:** retain batching, concurrency caps, and rate limiting; monitor queue depth and adjust worker scale.

## Status
- Design doc v6.1 adopted; implementation ready to begin.
