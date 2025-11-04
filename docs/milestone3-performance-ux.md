# Milestone 3 — Performance & Reconnect UX

## Goals
- Deliver translation/proofread P50 ≤ 35 s, P90 ≤ 60 s on reference corpus.
- Reduce token spend ≥ 40 % versus pre-v2 baseline.
- Ensure users reconnecting from any client see up-to-date run progress instantly.

## Scope
### Server
- Expose workflow snapshot APIs (`GET /projects/:id/workflows/active`, `GET /workflows/:runId/summary`).
- Persist stream event summaries (stage/tier/run) for translation + proofread runs.
- Emit heartbeat events + retry metadata consistently for all stages.
- Optimize OpenAI IO: shared client pools, keep-alive, HTTP/2, batched persistence.

### Client
- On app/project load, fetch active runs and hydrate workflow store before opening SSE.
- Auto-resubscribe to SSE using persisted `run_id`; show `recovering` while reconnecting.
- Display reconnect/recovery metrics (last update time, retry countdown) in Timeline/Sidebar.

### Observability
- Dashboard widgets: latency (P50/P90), retry causes, cache hit rate, reconnect recovery time/failure.
- Alerting thresholds for reconnect failure rate, excessive recovery durations.

## Dependencies
- Milestone 2 completion (A2/A3 stabilization + common schema adoption).
- Response v2 payload + pagination rolled out to translation and proofread.

## Open Questions
- How much history do we retain for resumed streams? (rolling window vs full log)
- Should reconnect polling fallback be shared with workflow timeline polling?

---
Last updated: $(date '+%Y-%m-%d')
