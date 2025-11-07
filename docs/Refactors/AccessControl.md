# Access Control & Concurrency Hardening

## Context
- Fastify middleware `requireAuthAndPlanCheck` verifies JWT + plan, but it does **not** ensure the caller belongs to the `projectId` they are accessing.
- Project-scoped routes (translation summary/stream/warmup, Proofread Editor APIs, etc.) fetch data keyed by `project_id`, so any authenticated user that guesses another project's ID can read or mutate foreign data.
- Workflow orchestration (`requestAction`) prevents overlapping runs via an application-level check, yet it performs the check and the subsequent inserts without locks or transactions, letting simultaneous requests bypass the guard.

## Goals
1. Guarantee that every project-scoped HTTP/SSE endpoint enforces user-project ownership before touching data.
2. Eliminate data leaks across tenants by ensuring canonical caches, pagination, proofread datasets, and streams are only served to authorized users.
3. Make workflow run creation atomic so that two users cannot start overlapping translation/proofread/quality runs for the same project by racing the API.

## Key Problems
### P1 — Missing Project Ownership Checks (Severity: Critical)
- `requireAuthAndPlanCheck` only sets `req.user_id`; routes such as `/api/projects/:projectId/translations/summary`, `/translations/:runId/items`, `/canonical/warmup`, Proofread Editor dataset/patch/stream, etc., never validate that `(projectId, user_id)` exists in `translationprojects`.
- Result: authenticated users can stream another user's translation progress, enqueue canonical warmups, or patch proofread segments, leading to cross-tenant data exposure and conflicting mutations.

### P2 — Workflow Run Race Conditions (Severity: High)
- `requestAction` checks `workflow_state` and inserts `workflow_runs` without a transaction or locking. Two concurrent calls both observe `status = 'idle'`, insert new runs, and update `workflow_state`, so duplicate translation/proofread jobs run in parallel.
- Side-effects: duplicated LLM spend, timeline mismatch (only the last write remains the "current" run), and downstream proofread/quality stages attaching to an orphaned parent run.

## Solutions
### S1 — Central Project Access Guard
- Introduce `assertProjectAccess(projectId: string, userId: string): Promise<void>` in `server/services/projectAccess.ts`.
- Implementation: `SELECT 1 FROM translationprojects WHERE project_id = $1 AND user_id = $2 LIMIT 1`. Throw `403` if missing.
- Apply the helper at the top of every project-scoped route (translation stream/summary/items/warmup, Proofread Editor endpoints, workflow routes, document profiles, etc.). SSE handlers must verify before `reply.hijack()` and abort unauthorized requests early.

### S2 — Middleware Integration
- Extend `requireAuthAndPlanCheck` to stash `req.projectAccess` helper or simply rely on the user_id it already sets; routes should call `assertProjectAccess` with that ID.
- Add regression tests that hit representative endpoints with mismatched user/project IDs and expect `403`.

### S3 — Transactional Workflow Requests
- Wrap `fetchWorkflowState + INSERT workflow_runs + UPSERT workflow_state` in a single DB transaction with `SELECT ... FOR UPDATE` on the `workflow_state` row (or create it if absent).
- Alternatively (additional safety), add a partial unique index on `workflow_runs(project_id, type)` where `status IN ('running','pending')` to enforce exclusivity at the DB level.
- Provide unit/integration tests that spawn concurrent `requestAction` invocations and assert only one run is accepted when `allowParallel` is not set.

## Work Plan (Priority-Ordered)
1. **Implement project access helper + tests**
   - Add `server/services/projectAccess.ts` with the ownership query.
   - Create Jest/Vitest tests covering allowed and denied cases.
2. **Enforce guard across critical routes**
   - Translation routes (`translationStream.ts`, REST pagination, canonical warmup).
   - Proofread Editor routes (`proofreadEditor.ts`, proofread SSE).
   - Any other `/api/projects/:projectId/...` handlers handling sensitive data (workflow, memory, chat, etc.).
   - Introduce shared Fastify preHandler (e.g., `withProjectAccess`) for consistency.
3. **Transaction-proof workflow actions**
   - Update `requestAction` to run inside a transaction/lock (using `BEGIN`, `SELECT ... FOR UPDATE`, commit/rollback).
   - Add DB constraint for additional safety and write integration tests to cover race scenarios.
4. **Regression verification + docs**
   - Exercise translation + proofread flows with two different users to confirm 403s on cross-project access.
   - Document the new guard + workflow locking in `docs/Refactors/translation-stream-refactor.md` and QA guides.

## Notes
- Apply changes before proceeding with Step 4 documentation/testing work so that the remaining refactors inherit correct isolation guarantees.
- Coordinate with DevOps to ensure any new DB constraints get applied in staging before production rollout.
