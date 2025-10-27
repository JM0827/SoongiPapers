# Translation Pipeline V2 Execution Plan

## Background
The current literal → style → emotion → QA sequence gives us four full retranslation passes. While it offers control knobs, it also introduces drift (each pass changes tone slightly), adds latency/cost, and produces stages that are hard to interpret from UX’s timeline.

For the new pipeline we will adopt **GPT-5** (or the next-gen successor) exclusively. GPT-4o remains the default for the legacy pipeline so we can A/B compare. GPT-5 usage notes:
- Verify JSON schema compliance (`response_format=json_schema`) and adjust retry logic if GPT-5 deviates more than GPT-4o.
- Expect different temperature/top-p behavior; we’ll keep V2 configuration knobs separate (`TRANSLATION_DRAFT_MODEL_V2`, `TRANSLATION_DRAFT_TEMPERATURE_V2`, etc.).
- Confirm GPT-5 context window supports n-best + deliberation payload size; adjust chunking if needed.
- Monitor cost/latency; n-best candidate count should remain configurable per project/flag.
- Ensure rate limits are set based on GPT-5 quota before enabling more projects.

We are moving to a **Draft → Revise** core with **optional Micro-Checks**. Key goals:
- Preserve literary nuance without four separate rewrites.
- Front-load glossary/style/persona constraints in a single strong Draft prompt.
- Enforce Evidence-Linked Translation (ELT) so every downstream edit references source spans.
- Keep Proofread workflow untouched while giving reviewers better evidence and guardrails.

This document captures the implementation plan and will be updated as we progress.

## Phase Plan Overview
1. Foundations & schema prep
2. Prompt infrastructure
3. n-best Draft pipeline
4. ELT enforcement
5. Revise stage
6. Micro-Checks guard
7. Proof UI enhancements
8. Observability & rollout

Each phase below lists action items.

---

## Phase 0 – Foundations
- Add `span_pairs` (JSONB) and optional `candidates[]` columns to `translation_drafts`.
- Ensure Proofread data loaders tolerate new fields.
- Introduce feature flag `TRANSLATION_PIPELINE_V2` to roll out per project.

## Phase 1 – Prompt Infrastructure
- Implement `promptBuilder.ts` to assemble system + user + format blocks.
- Normalize translation notes (glossary, personas, measurement units) into prompt-ready chunks with fallbacks.
- Unit tests to verify required sections even when inputs are missing.
- Prepare V2 model config: env vars for GPT-5 (draft, revise, judge) so we can tune temperature/top-p without touching legacy settings.

## Phase 2 – n-best Draft Pipeline
- For each chunk, generate 2–3 low-temperature candidates with identical prompts.
- Create `deliberationAgent` to judge candidates on glossary fidelity, tone, ELT completeness.
- Store all candidates, best ID, and rationale in DB for auditing.
- Default model = GPT-5 (via `TRANSLATION_DRAFT_MODEL_V2`); legacy GPT-4o pipeline untouched.

## Phase 3 – ELT Enforcement
- Parse agent output into `span_pairs`; validator checks coverage, offsets, duplicates.
- Auto-retry or heuristic align when validation fails; log metrics.
- Propagate span metadata to Revise, Micro-Checks, Proof UI APIs.

## Phase 4 – Revise Stage
- Build `revisionAgent` consuming chosen Draft, translation notes, `span_pairs`.
- Prompt emphasises “preserve meaning, adjust rhythm/naturalness only; keep evidence links”.
- Output revised text + updated `span_pairs + revise_actions` for audit.

## Phase 5 – Micro-Checks Guard
- Implement rule engine (`microGuards.ts`) with pluggable checks: terminology, proper nouns, numbers/units, quotes/dashes, length ratio, reverse translation spot check.
- Run automatically post-Revise; only patch offending segments, otherwise flag for human review.
- Surface violations in Proof UI and logs.

## Phase 6 – Proof UI Enhancements
- Add "Show Evidence" toggle using `span_pairs` for bidirectional highlights.
- Introduce undo/redo stack tied to span IDs plus audit logging.
- Display Micro-Check guard badges per segment.

## Phase 7 – Observability & Metrics
- Track token usage, latency, Draft candidate counts, ELT coverage %, Micro-Check violations.
- Evaluate COMET/BLEURT on Draft vs Revise; log MQM (human) for pilot projects.

## Phase 8 – Rollout & Training
- Enable pipeline for pilot cohort under feature flag; compare KPIs vs old flow.
- Update documentation, ops playbooks, and UI copy (timeline labels, guard messages).
- Once KPIs met (cost ↓≥20%, human edit rate ≤30%, MQM errors ↓), retire literal/style/emotion/QA config.

---

## Risks & Mitigations
- **Prompt drift** – version prompts in repo; add regression tests with synthetic texts.
- **ELT mismatches** – start with shorter segments; block release if coverage <95%.
- **Cost control** – log per-stage tokens; adapt n-best count dynamically.
- **Change management** – Proof UI retains functions; provide guard-badge training.
- **GPT-5 readiness** – schema compliance/rate limit differences vs GPT-4o; keep V2 model knobs separate and fall back to GPT-4o if GPT-5 endpoints degrade.

## Success Criteria
- Net cost or latency reduced ≥20% from legacy pipeline.
- Human edit rate ≤30% of segments.
- MQM error rate trending downward; COMET/BLEURT stable or improved.
- Reviewer satisfaction improves (survey) due to ELT visibility + targeted guards.

*Update this document as tasks complete or scope shifts.*
