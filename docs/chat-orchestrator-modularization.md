# Chat Orchestrator Modularization – Detailed Design

## 1. Context
- `ChatOrchestrator` currently spans ~3,500 lines and mixes streaming, workflow automation, editing assistant flows, file upload, and UI layout inside a single component (`web/src/components/chat/ChatOrchestrator.tsx`, see e.g. `handleSend` at `web/src/components/chat/ChatOrchestrator.tsx:2835`, editing command handlers at `web/src/components/chat/ChatOrchestrator.tsx:826`, upload flow at `web/src/components/chat/ChatOrchestrator.tsx:3017`).
- Prior work introduced `useChatMessages`, `ChatMessage`, `QuickReplies`, and `WorkflowTimeline`, but orchestration logic still resides in the top-level component.
- Both internal docs (`docs/Chat 개선 계획.md`) and recent design reviews call for modularization to improve readability, reuse, and testability.

## 2. Goals
1. Separate business logic (streaming, editing, workflow recommendations, uploads) from presentational JSX so each concern can be developed and tested independently.
2. Provide explicit module boundaries and APIs for orchestrating chat interactions so future features (e.g., new workflow actions) touch focused files.
3. Preserve existing behavior, stores, and APIs during refactor; the plan is structural only.
4. Establish a phased rollout path with guard rails (unit tests + manual checks) to minimize regression risk.

## 3. Non-Goals
- Replacing `useChatMessages` or changing message persistence semantics.
- Rewriting backend integrations (`api.chatStream`, `api.chat`, upload endpoints) or agent hooks (`useTranslationAgent`, `useProofreadAgent`, `useQualityAgent`).
- Altering UI look & feel beyond necessary layout wrapping; styling tweaks can happen later.
- Introducing a new state management library; we continue using existing Zustand stores.

## 4. Current Pain Points (Representative References)
- **Mega send flow** – `handleSend` handles optimistic message append, local routing, streaming SSE, REST fallback, and post-processing (`web/src/components/chat/ChatOrchestrator.tsx:2835`).
- **Action adaptation & dispatch** – translation/workflow actions are filtered and executed inline (`web/src/components/chat/ChatOrchestrator.tsx:565`, `web/src/components/chat/ChatOrchestrator.tsx:2476`).
- **Editing assistant lifecycle** – inference, suggestion creation, apply/undo/dismiss logic intermixed with UI, spanning >250 lines (`web/src/components/chat/ChatOrchestrator.tsx:826`, `web/src/components/chat/ChatOrchestrator.tsx:1096`).
- **Upload orchestration** – drag/drop, validation, project bootstrap, and assistant messaging live inside the component (`web/src/components/chat/ChatOrchestrator.tsx:3017`).
- **Layout management** – scroll anchors, resize observers, and jump-to-latest button logic are co-located with business logic (`web/src/components/chat/ChatOrchestrator.tsx:3164`).

## 5. Target Architecture Overview
```
ChatOrchestrator (thin)
├── ChatOrchestratorContext (provider)
├── useChatController            # streaming, actions, message orchestration
├── useEditingAssistant          # editing helper lifecycle
├── useWorkflowProgress          # derived workflow/summary state
├── useOriginUpload              # file upload orchestration
├── useAutoScroller              # message scroll management
├── ChatLayout                   # shell layout
│   ├── ChatStatusPanel          # header, status, recommendations
│   ├── OriginDropzone           # file upload UI
│   ├── ChatTimeline             # message list + anchors
│   └── ChatComposer             # chat input + quick replies
└── Shared utilities (lib/chatActions.ts)
```

### 5.1 Hook Responsibilities & APIs
| Hook | Location | Responsibilities | Inputs | Outputs |
| ---- | -------- | ---------------- | ------ | ------- |
| `useChatController` | `web/src/hooks/chat/useChatController.ts` | Encapsulate `handleSend`, SSE streaming, REST fallback, action adaptation, local question routing, assistant persistence, expose busy/error state | `snapshot`, `projectId`, `token`, `selectedModel`, `api`, existing stores (`useChatMessages`, `useChatActionStore`) | `{ send, pushAssistant, registerActionExecutor, state }` |
| `useEditingAssistant` | `web/src/hooks/chat/useEditingAssistant.ts` | Infer editing mode, orchestrate suggestion requests, quick replies, apply/undo/dismiss, manage pending selection | adapters (editor), stores (`useEditingCommandStore`, `useUIStore`), `api`, `pushAssistant` | `{ onUserInput, onSelectionQueued, quickReplies, actions }` |
| `useWorkflowProgress` | `web/src/hooks/chat/useWorkflowProgress.ts` | Produce `translationVisual`, `proofreadingVisual`, `qualityVisual`, recommendation list, stage anchors | `snapshot`, agent states, localization helpers | `{ stages, recommendations, stageAnchors }` |
| `useOriginUpload` | `web/src/hooks/chat/useOriginUpload.ts` | Validate files, bootstrap project, call upload API, expose drag/drop handlers, upload state | `projectId`, `token`, `createProject`, `api`, `pushAssistant`, callbacks | `{ isUploading, showUploader, handlers, ensureUploaderVisible }` |
| `useAutoScroller` | `web/src/hooks/chat/useAutoScroller.ts` | Manage scroll-to-bottom behavior, resize observer, `showJumpButton` toggling | message refs, composer ref | `{ containerRef, bottomRef, onUserScroll, showJumpButton, jumpToLatest }` |

### 5.2 Presentational Components
| Component | Location | Purpose |
| --------- | -------- | ------- |
| `ChatLayout.tsx` | `web/src/components/chat/ChatLayout.tsx` | Arrange header, timeline, composer; consume context hooks |
| `ChatStatusPanel.tsx` | `web/src/components/chat/ChatStatusPanel.tsx` | Header title, language badge, workflow chips, recommendations |
| `ChatTimeline.tsx` | `web/src/components/chat/ChatTimeline.tsx` | Render messages, anchors, scroll button; reuse existing `ChatMessage` |
| `ChatComposer.tsx` | `web/src/components/chat/ChatComposer.tsx` | Wrap `ChatInput` + quick replies; surface send/disabled state |
| `OriginDropzone.tsx` | `web/src/components/chat/OriginDropzone.tsx` | Render upload CTA, drop handlers from `useOriginUpload` |

`ChatMessage.tsx`, `QuickReplies.tsx`, `ActionBadge.tsx`, and `WorkflowTimeline.tsx` remain in place but consume data via context rather than direct state.

### 5.3 Context Provider
- `web/src/contexts/ChatOrchestratorContext.tsx`
  - Exposes `{ messages, send, pushAssistant, workflow, upload, editing, scroll, uiState }` to descendants.
  - Provides memoized selectors so components can opt-in to slices.
  - Backed by `useChatMessages` for message data.

### 5.4 Shared Utilities
- `web/src/lib/chatActions.ts`
  - `adaptChatActionsForOrigin(actions, deps)` – extracted from current `adaptActionsForOrigin`.
  - `dedupeDisplayableActions(actions)` – extracted from `formatActionsForDisplay`.
  - Pure functions with unit coverage to guarantee deterministic action filtering.

## 6. Data Flow & Interaction Notes
1. **Sending a message**
   - `ChatComposer` calls `context.send`.
   - `useChatController` appends optimistic user message via `useChatMessages`, runs `handleLocalQuestion`, initiates streaming request, receives deltas, updates assistant placeholder, and dispatches completed actions.
   - `useChatController` publishes action execution callbacks into `useChatActionStore` so other UI (buttons/cards) can trigger the same logic.
2. **Editing assistant**
   - When `useEditingCommandStore` queues a pending selection, `useEditingAssistant` surfaces quick replies and handles user follow-up input.
   - `ChatComposer` asks `useEditingAssistant` whether the user input should short-circuit send and convert into an editing request.
3. **Workflow recommendations**
   - `useWorkflowProgress` consumes state from translation/proofread/quality agents, deriving timeline visuals and CTA recommendations; `ChatStatusPanel` renders them.
   - Actions emitted from recommendations rely on `useChatController`’s dispatcher.
4. **Upload handling**
   - `OriginDropzone` reflects `useOriginUpload` state; when uploads succeed, callbacks (`onOriginSaved`) bubble up to refresh project context.
5. **Scrolling**
   - `ChatTimeline` wires refs returned by `useAutoScroller`; jump button state and scroll events remain encapsulated.

## 7. Milestones & Deliverables
| Milestone | Scope | Key Files | Validation |
| --------- | ----- | --------- | ---------- |
| **M1 – Controller & Scrolling Extraction** | Introduce `useChatController` and `useAutoScroller`; move existing logic without JSX changes. `ChatOrchestrator` delegates send/stream and scroll refs. | `useChatController.ts`, `useAutoScroller.ts`, updated `ChatOrchestrator.tsx` | Unit tests for controller streaming callbacks; verify manual chat send/stream.
| **M2 – Editing Assistant Hook** | Migrate editing-related logic (inference, apply/undo/dismiss, quick replies) into `useEditingAssistant`; `ChatOrchestrator` consumes hook output. | `useEditingAssistant.ts`, `ChatOrchestrator.tsx`, tests under `web/src/hooks/__tests__/` | Hook tests for suggestion flows; manual editing QA.
| **M3 – Presentational Split** | Introduce `ChatLayout`, `ChatStatusPanel`, `ChatTimeline`, `ChatComposer`; `ChatOrchestrator` provides context values. | new components under `web/src/components/chat/`, `ChatOrchestrator.tsx` | Component snapshot/unit tests; manual chat regression.
| **M4 – Workflow & Upload Hooks** | Extract `useWorkflowProgress`, `useOriginUpload`, `OriginDropzone`; move recommendation creation and upload handlers. | corresponding hook files, update context | Tests for recommendations, upload validation paths; manual upload QA.
| **M5 – Cleanup & Docs** | Create `ChatOrchestratorContext`, relocate utilities to `lib/chatActions.ts`, prune dead code, update docs/tests. | context file, `lib/chatActions.ts`, docs, tests | Full `npm test --prefix web`; doc updates (`docs/0.사용자인터페이스.md`).

**Target schedule** (assuming dedicated effort):
- M1: 2 days (heavy review).
- M2: 2 days.
- M3: 3 days (component redraw + QA).
- M4: 2 days.
- M5: 1 day.
- Buffer/regression: 1 day.

## 8. Testing Strategy
- **Unit / Hook tests**
  - `useChatController` streaming happy path, SSE error fallback, deduped action emission.
  - `useEditingAssistant` apply/undo/dismiss flows, inference heuristics, quick reply generation.
  - `useWorkflowProgress` stage derivation and recommendation gating.
  - `useOriginUpload` validation (unsupported extension, empty file, project auto-create failure).
- **Component tests (Vitest + Testing Library)**
  - `ChatComposer` send button disabled when busy/uploading.
  - `ChatStatusPanel` renders recommendations from provided context snapshot.
- **Manual QA** (per milestone)
  - Basic chat exchange with streaming + fallback.
  - Editing suggestion application in the document editor.
  - File upload via click and drag/drop; project auto-create when absent.
  - Workflow triggers (start translation/proofread/quality, open preview tabs).

## 9. Risks & Mitigations
| Risk | Mitigation |
| ---- | ---------- |
| Regression in streaming flow due to refactor | Keep API surface identical; add hook tests mocking `api.chatStream`; compare behavior against pre-refactor snapshots.
| Tight coupling to Zustand stores complicates extraction | Provide stores as dependencies to hooks (pass selectors) so we can mock during tests.
| Increased render passes due to context provider | Memoize context slices; components subscribe to minimal data.
| Upload/drag events breaking due to DOM restructuring | Preserve existing DOM hierarchy in `OriginDropzone`; audit Tailwind classes for overflow/height.
| Recommendation actions losing dedupe logic | House action utilities in `lib/chatActions.ts` with tests ensuring parity.

## 10. Definition of Done
- `ChatOrchestrator.tsx` reduced to <300 lines, focusing on composition and context wiring.
- All new hooks exported under `web/src/hooks/chat/` with corresponding tests.
- Presentational components render using values from context; no business logic remains in JSX tree.
- `lib/chatActions.ts` hosts shared action utilities with unit coverage.
- Documentation updated (`docs/0.사용자인터페이스.md` + this plan) describing new structure.
- CI (`npm test --prefix web`) passes; manual smoke for chat, editing, uploads, workflow triggers succeeds.

## 11. Open Questions
1. Should `useChatController` expose telemetry hooks or leave logging to callers? (Currently logging occurs inline; decision pending.)
2. Do we want a feature flag for the refactored layout to enable gradual rollout, or is a single switchover acceptable?
3. Can we collapse agent hook dependencies (`useTranslationAgent`, `useProofreadAgent`, `useQualityAgent`) into the new context, or should they remain in `ChatOrchestrator` for now? (Proposal keeps them in the composition layer.)
4. Are there localization updates needed once recommendation copy moves? (Ensure i18n keys remain consistent.)

