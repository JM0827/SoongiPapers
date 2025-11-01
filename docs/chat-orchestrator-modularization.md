# Chat Orchestrator Modularization – Detailed Design

## 1. Context

- `ChatOrchestrator` currently spans ~3,500 lines and mixes streaming, workflow automation, editing assistant flows, file upload, and UI layout inside a single component (`web/src/components/chat/ChatOrchestrator.tsx`; e.g. `handleSend` at `web/src/components/chat/ChatOrchestrator.tsx:2835`, editing handlers at `web/src/components/chat/ChatOrchestrator.tsx:826`, upload pipeline at `web/src/components/chat/ChatOrchestrator.tsx:3017`).
- Prior work extracted UI primitives (`ChatMessage`, `QuickReplies`, `WorkflowTimeline`) and introduced `useChatMessages`, yet orchestration logic still lives in the top-level component, limiting reuse/testing.
- `docs/Chat 개선 계획.md` and the latest architecture review both call for staged modularization to reduce complexity and regression risk.

## 2. Objectives

1. Isolate business logic (streaming, action dispatch, editing assistant, uploads, workflow derivations) into dedicated hooks and utilities so each concern can be unit-tested independently.
2. Reduce `ChatOrchestrator` to a thin composition layer that wires hooks, context, and presentational components without embedding business rules.
3. Preserve existing runtime behavior and API contracts (agents, stores, backend calls) during refactor; changes are structural only.
4. Provide a milestone-by-milestone implementation guide that a junior engineer can follow, including entry points, test expectations, and verification steps.

## 3. Non-Goals

- Replacing Zustand stores or changing message persistence semantics.
- Modifying backend integrations (`api.chatStream`, `api.chat`, upload endpoints) or agent hook implementations (`useTranslationAgent`, `useProofreadAgent`, `useQualityAgent`).
- UX redesign beyond necessary layout shims; styling tweaks can be deferred.
- Introducing feature flags or new dependency stacks.

## 4. Decisions (Architect Responses)

| Topic                    | Decision                                                                                                                                                                                                                                             | Notes |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| **Telemetry / logging**  | `useChatController` gains an optional `onEvent` callback for structured telemetry (e.g. `{ type: 'stream-error', error }`). When absent, the hook logs to `console` (matching current behavior). No global telemetry API required for this refactor. |
| **Rollout flag**         | No feature flag. Refactored layout replaces the existing one once QA passes. Use PR-level validation and regression checklists instead of runtime gating.                                                                                            |
| **Agent hooks location** | `useTranslationAgent`, `useProofreadAgent`, `useQualityAgent`, and `useWorkflowGuideAgent` remain instantiated in `ChatOrchestrator` (thin layer). Their derived state is passed into context/hooks as inputs.                                       |
| **Localization**         | Reuse existing i18n keys. Any new helper text introduced during extraction should follow existing naming conventions and be added alongside current locale entries.                                                                                  |

## 5. Target Architecture Overview

```
ChatOrchestrator (thin)
├── ChatOrchestratorContext (provider)
├── useChatController            # streaming & action orchestration
├── useEditingAssistant          # editing helper lifecycle
├── useWorkflowProgress          # derived workflow visuals & recommendations
├── useOriginUpload              # file upload orchestration
├── useAutoScroller              # message scroll / jump management
├── ChatLayout                   # layout shell
│   ├── ChatStatusPanel          # header, badges, recommendations
│   ├── OriginDropzone           # upload CTA + drag&drop
│   ├── ChatTimeline             # messages + anchors + jump button
│   └── ChatComposer             # input + quick replies
└── lib/chatActions.ts           # action adaptation & dedupe helpers
```

## 6. Hook & Utility Specifications

### 6.1 `useChatController`

**Location**: `web/src/hooks/chat/useChatController.ts`

**Dependencies**:

- `useChatMessages` (for `messages`, `addMessage`, `updateMessage`, `syncHistory`, `reset`).
- `useChatActionStore` (`setExecutor`, `getState`).
- `api` methods: `chatStream`, `chat`, `chatLog`.
- `adaptChatActionsForOrigin`, `dedupeDisplayableActions` (new lib helpers).
- Optional `onEvent?: (event: ChatControllerEvent) => void`.

**Exports**:

```ts
interface UseChatControllerArgs {
  snapshot: ProjectContextSnapshot;
  projectId: string | null;
  token: string | null;
  selectedModel: string | null;
  api: typeof api;
  pushAssistantBase: (message: MessageInput) => void; // thin wrapper for `pushAssistant`
  registerExternalActionExecutor?: (fn: ChatActionExecutor | null) => void;
  onEvent?: (event: ChatControllerEvent) => void;
}

interface ChatControllerState {
  isStreaming: boolean;
  lastError: string | null;
}

interface UseChatControllerResult {
  send: (text: string) => Promise<void>;
  pushAssistant: (...args) => void; // re-exposes enriched push helper
  state: ChatControllerState;
}
```

**Responsibilities**:

1. Append user messages optimistically (`addMessage`) and manage assistant placeholders.
2. Route “local questions” (origin/translation opening, etc.) before hitting the API.
3. Initiate SSE streaming via `api.chatStream`; apply deltas, finalize reply, and execute returned actions.
4. On stream error, fallback to `api.chat`; persist replies (via `chatLog`) when needed.
5. Normalize actions via lib helpers, call `processAssistantActions` callback, and expose executor through `useChatActionStore`.
6. Maintain busy/error state and emit optional telemetry events:
   - `stream-start`, `stream-delta`, `stream-complete`, `stream-error`, `rest-fallback`, `rest-error`.

**Implementation Steps (Milestone 1)**:

1. Copy existing `handleSend`, `pushAssistant`, `adaptActionsForOrigin`, `formatActionsForDisplay`, `handleMessageAction`, `handleLocalQuestion` logic into the new hook file.
2. Replace direct store mutations with hook arguments (`pushAssistantBase`).
3. Emit `onEvent?.({ type: 'stream-error', error })` alongside existing `console.warn` calls.
4. Return `send` function to caller; update `ChatOrchestrator` to consume the hook and remove inline logic.

### 6.2 `useAutoScroller`

**Location**: `web/src/hooks/chat/useAutoScroller.ts`

**Responsibilities**:

- Manage refs for message container and bottom anchor.
- Observe scroll position; expose `showJumpButton`, `onScroll`, and `jumpToLatest(behavior)`.
- Handle composer height changes via `ResizeObserver`.

**Exports**:

```ts
interface AutoScrollerArgs {
  scrollThresholdPx?: number; // default 40
}

interface AutoScrollerResult {
  containerRef: RefObject<HTMLDivElement>;
  bottomRef: RefObject<HTMLDivElement>;
  composerRef: RefObject<HTMLDivElement>;
  showJumpButton: boolean;
  isAtBottom: boolean;
  registerComposerObserver(): void; // invoked in effect
  jumpToLatest: (behavior?: ScrollBehavior) => void;
  handleUserScroll: () => void;
  composerHeight: number;
}
```

**Implementation Steps**:

1. Move scroll-related `useEffect` / `useLayoutEffect` blocks into the hook.
2. Provide `registerComposerObserver` to set up `ResizeObserver` when `composerRef` is available.
3. Expose `composerHeight` so `ChatTimeline` can pad the message list as before.

### 6.3 `useEditingAssistant`

**Location**: `web/src/hooks/chat/useEditingAssistant.ts`

**Responsibilities**:

- Track active/pending editing actions via `useEditingCommandStore`.
- Infer intent from user input (current `guessEditingIntent`).
- Request suggestions (API bridge), manage quick replies, apply/undo/dismiss flows.
- Communicate with the editor adapter (`editorAdapter.replaceText`).
- Use `pushAssistant` for user feedback.

**Exports**:

```ts
interface EditingAssistantArgs {
  pushAssistant: (text: string, options?: PushOptions) => void;
  projectId: string | null;
  token: string | null;
  snapshot: ProjectContextSnapshot;
  api: typeof api;
  localize: LocalizeFn;
}

interface EditingAssistantResult {
  handleUserInput: (message: string) => Promise<"handled" | "skip">;
  quickReplies: QuickReplyItem[];
  activeAction: EditingActionType | null;
  resetQuickReplies: () => void;
}
```

**Implementation Steps (Milestone 2)**:

1. Relocate `guessEditingIntent`, `processEditingCommand`, `requestEditingSuggestion`, `applyEditingSuggestion`, `undoEditingSuggestion`, `dismissEditingSuggestion`, `buildSuggestionMessage`, `buildEditingQuickReplies` into the hook.
2. Internally use `useEditingCommandStore` selectors; hook returns minimal API for `ChatComposer` and `ChatStatusPanel`.
3. Provide unit tests covering success/failure paths, editor adapter absence, and warning accumulation.

### 6.4 `useWorkflowProgress`

**Location**: `web/src/hooks/chat/useWorkflowProgress.ts`

**Responsibilities**:

- Consume translation/proofread/quality agent state + snapshot.
- Derive `translationVisual`, `proofreadingVisual`, `qualityVisual` (existing `useMemo` logic) and sequential stage arrays.
- Create recommendation list (currently `buildRecommendations`).

**Exports**:

```ts
interface WorkflowProgressArgs {
  snapshot: ProjectContextSnapshot;
  translation: TranslationAgentState;
  proofreading: ProofreadAgentState;
  quality: QualityAgentState;
  localize: LocalizeFn;
  hasOrigin: boolean;
  translationPrepReady: boolean;
}

interface WorkflowProgressResult {
  translationVisual: TranslationVisual | null;
  proofreadingVisual: ProofVisual | null;
  qualityVisual: QualityVisual | null;
  recommendations: RecommendationItem[];
  stageAnchors: StageAnchorRefs; // mapping for scroll anchors
}
```

**Implementation Steps (Milestone 4)**:

1. Extract existing `translationVisual` `useMemo`, `proofreadingVisual`, `qualityVisual`, and `buildRecommendations` logic.
2. Provide typed outputs consumed by `ChatStatusPanel` / `ChatTimeline`.
3. Add unit tests for each combination of running/done/failed states and recommendation eligibility.

### 6.5 `useOriginUpload`

**Location**: `web/src/hooks/chat/useOriginUpload.ts`

**Responsibilities**:

- Validate files (extension, size) using existing helpers.
- Auto-create project if missing (`useCreateProject` wrapper).
- Execute `api.uploadOriginFile`; expose `isUploading`, `isDragging`, handlers.
- Trigger assistant messages and callbacks (`onOriginSaved`).

**Exports**:

```ts
interface OriginUploadArgs {
  token: string | null;
  projectId: string | null;
  createProject: () => Promise<Project>;
  pushAssistant: PushAssistantFn;
  onOriginSaved?: () => void;
}

interface OriginUploadResult {
  isUploading: boolean;
  isDragging: boolean;
  showUploader: boolean;
  dropzoneProps: {
    onDragOver: (event: DragEvent<HTMLDivElement>) => void;
    onDrop: (event: DragEvent<HTMLDivElement>) => void;
    onDragLeave: (event: DragEvent<HTMLDivElement>) => void;
  };
  fileInputProps: {
    ref: Ref<HTMLInputElement>;
    onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  };
  openFileDialog: () => void;
  ensureUploaderVisible: () => void;
}
```

**Implementation Steps (Milestone 4)**:

1. Move `processFile`, `handleFileSelect`, `handleDrop`, `handleDragOver`, `handleDragLeave`, and `openFileDialog` logic into the hook.
2. Manage `showUploader` internally; expose setter functions.
3. Provide tests for unsupported extension, zero-byte file, project auto-create success/failure, and upload success.

### 6.6 `lib/chatActions.ts`

**Location**: `web/src/lib/chatActions.ts`

**Functions**:

- `adaptChatActionsForOrigin(actions, deps)` – replicates existing guard logic (origin presence, prep readiness, duplicates) with dependency injection for `hasOrigin`, `translationPrepReady`, etc.
- `dedupeDisplayableActions(actions)` – filters `autoStart`, ensures stable dedupe by `(type|jobId|workflowRunId|reason|label)` key.

**Tests**: Provide pure unit tests verifying the scenarios currently covered inline (e.g., blocking `startTranslation` when prep incomplete).

## 7. Context Provider Contract

**Location**: `web/src/contexts/ChatOrchestratorContext.tsx`

**Shape**:

```ts
interface ChatOrchestratorContextValue {
  messages: Message[];
  send: (text: string) => Promise<void>;
  pushAssistant: PushAssistantFn;
  controllerState: ChatControllerState;
  editing: ReturnType<typeof useEditingAssistant>;
  workflow: WorkflowProgressResult;
  upload: OriginUploadResult;
  autoScroller: AutoScrollerResult;
  snapshot: ProjectContextSnapshot;
  project: {
    id: string | null;
    title: string | null;
    targetLang: string | null;
  };
}
```

**Implementation Notes**:

- Use `useMemo` to avoid recomputation.
- Provide a `useChatOrchestrator()` hook with error throw if context missing.
- `ChatOrchestrator` wraps children (`ChatLayout`) with this provider.

## 8. Presentational Components

### 8.1 `ChatLayout.tsx`

- Accept context values via `useChatOrchestrator()`.
- Compose children: header (`ChatStatusPanel` + `OriginDropzone`), main (`ChatTimeline`), footer (`ChatComposer`).
- No business logic; only layout classes and prop passing.

### 8.2 `ChatStatusPanel.tsx`

- Props: `project`, `workflow`, `isUploading`, `historyLoading`, `recommendations`, `onRecommendationClick` (wired to controller dispatcher).
- Render title, language pair, status chips, recommendations with CTA buttons.

### 8.3 `OriginDropzone.tsx`

- Props: `upload` result, `localize`, `showUploader`, `dropzoneClasses`.
- Render hidden input + dropzone UI; call `upload.openFileDialog`, `ensureUploaderVisible` as needed.

### 8.4 `ChatTimeline.tsx`

- Props: `messages`, `autoScroller`, `composerHeight`, `messagePaddingClass`, `quickReplies` presence, `localize` strings.
- Render anchor divs, message list, `Jump to latest` button with `autoScroller.showJumpButton`.

### 8.5 `ChatComposer.tsx`

- Props: `send`, `disabled`, `prefill`, `quickReplies`, `onQuickReplySelect`, `onChangePrefill`, `editing assistant API`.
- Wrap `ChatInput`; route user input through `useEditingAssistant.handleUserInput` before calling `send`.

## 9. Implementation Milestones

### Milestone 1 – Controller & Scrolling Extraction (2 days)

**Tasks**:

1. Create `useChatController.ts`, move `handleSend`, `pushAssistant`, action helpers, and local question routing.
2. Create `lib/chatActions.ts` with extracted pure functions + tests.
3. Create `useAutoScroller.ts` and adjust `ChatOrchestrator.tsx` to use it.
4. Update `ChatOrchestrator.tsx` to call `controller.send` in place of inline `handleSend`.

**Testing**:

- Unit: `useChatController.test.ts` mocking `api.chatStream`/`api.chat` and verifying delta merge, fallback, action execution.
- Unit: `chatActions.test.ts` verifying adaptation/dedupe rules.
- Manual: send message with streaming, unplug network (simulate SSE error) to confirm fallback.

### Milestone 2 – Editing Assistant Hook (2 days)

**Tasks**:

1. Implement `useEditingAssistant.ts` moving editing logic.
2. Update `ChatOrchestrator` and `ChatInput` interactions to use hook output.
3. Provide `useEditingAssistant.test.ts` covering all flows (success, failure, editor missing, warnings).

**Manual QA**: Trigger rewrite/name/pronoun suggestions, apply/undo/dismiss through UI.

### Milestone 3 – Presentational Split (3 days)

**Tasks**:

1. Implement `ChatOrchestratorContext`.
2. Create `ChatLayout`, `ChatStatusPanel`, `ChatTimeline`, `ChatComposer`, `OriginDropzone` components.
3. Update `ChatOrchestrator.tsx` to render `ChatLayout` within the provider, pass hook results via context.
4. Ensure CSS classes mirror current layout (inspect before/after).

**Testing**:

- Component tests verifying header renders project info and recommendations.
- Snapshot tests for `ChatTimeline` with sample messages.
- Manual regression of entire chat UI.

### Milestone 4 – Workflow & Upload Hooks (2 days)

**Tasks**:

1. Implement `useWorkflowProgress` and `useOriginUpload`.
2. Refactor `ChatStatusPanel` to use `workflow` output.
3. Refactor `OriginDropzone` + context wiring to use new hook.
4. Write unit tests for recommendation gating and upload validation.

**Manual QA**: Start translation/proofread/quality, verify recommendations, upload files via drag/drop and file picker.

### Milestone 5 – Cleanup & Documentation (1 day)

**Tasks**:

1. Delete unused functions from `ChatOrchestrator.tsx`, ensuring file <300 lines.
2. Update `docs/0.사용자인터페이스.md` and any diagrams.
3. Ensure new localization keys (if any) exist in locale resources.
4. Final run of `npm test --prefix web` + smoke checklist.

**Deliverables**: Updated documentation, green CI, QA sign-off.

## 10. Testing Strategy (Detailed)

- **Unit/Hook Tests** (stored under `web/src/hooks/__tests__/`):
  - `useChatController.test.ts`: simulate SSE success/failure, verify `onEvent` emission, fallback behavior, action dedupe.
  - `useEditingAssistant.test.ts`: cover inference with and without selection, API failure, editor adapter missing, warnings appended.
  - `useWorkflowProgress.test.ts`: feed snapshot permutations to ensure correct stage labeling.
  - `useOriginUpload.test.ts`: invalid file type, zero-byte file, project auto-create success/failure, upload success.
  - `chatActions.test.ts`: ensure `startTranslation` blocked when no origin/prep incomplete, dedupe removes duplicates.
- **Component Tests** (e.g., `ChatStatusPanel.test.tsx`, `ChatComposer.test.tsx`):
  - Validate disabled states, quick reply rendering, recommendation CTA binding.
- **Integration Tests** (optional stretch): simulate whole message send flow via Testing Library with mocks.
- **Manual QA Checklist**:
  1. Standard chat send with SSE streaming.
  2. Force SSE error (devtools throttling) to observe REST fallback.
  3. Editing suggestion request/apply/undo/dismiss.
  4. File upload via click and drag/drop, including invalid extension rejection.
  5. Workflow action buttons start translation/proofread/quality as before.
  6. Scroll behavior: jump-to-latest button shows/hides appropriately.

## 11. Rollout Plan

- Single release once all milestones complete and regression checklist passes.
- Communicate change via release notes referencing this design doc.
- Keep pre-refactor branch for comparison until post-release stability confirmed.

## 12. Risks & Mitigations

| Risk                                 | Mitigation                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| Streaming regression due to refactor | Maintain exhaustive hook tests; use captured fixtures for SSE events.                      |
| Increased renders via context        | Memoize context value slices; export selectors (e.g., `useChatMessages` already memoized). |
| Upload drag/drop breakage            | Keep DOM hierarchy stable in `OriginDropzone`; test in Chrome/Edge.                        |
| Unhandled localization keys          | Track new keys in PR checklist; run i18n extraction if available.                          |
| Tight coupling to agent hooks        | Keep agents in `ChatOrchestrator`, pass derived state to hooks via args only.              |

## 13. Definition of Done

- `ChatOrchestrator.tsx` ≤ 300 lines (composition only).
- All new hooks/components/utilities implemented with tests.
- `ChatOrchestratorContext` powers all chat UI; business logic confined to hooks/utilities.
- Documentation updated (`docs/chat-orchestrator-modularization.md`, `docs/0.사용자인터페이스.md`).
- `npm test --prefix web` green; manual smoke checklist completed.

## 14. Appendix – Implementation Checklist per Milestone

### M1 Quick Steps

- [ ] Scaffold `useChatController.ts` with arguments and return types.
- [ ] Move `handleLocalQuestion`, `processAssistantActions`, `adaptActionsForOrigin`, `formatActionsForDisplay`, streaming logic.
- [ ] Implement `onEvent` emission; default to `console` logging.
- [ ] Update `ChatOrchestrator` to call `controller.send`, attach `registerExternalActionExecutor`.
- [ ] Create `useAutoScroller.ts` replicating scroll logic; adjust JSX refs.
- [ ] Write unit tests; run manual chat send.

### M2 Quick Steps

- [ ] Implement `useEditingAssistant` with API bridges and editor adapter interaction.
- [ ] Update `ChatComposer` (temporary shim) to call `handleUserInput` before `send`.
- [ ] Extend tests for editing flows; manual check.

### M3 Quick Steps

- [ ] Implement context provider and helper hook.
- [ ] Create new presentational components; ensure Tailwind classes match existing layout.
- [ ] Rewire `ChatOrchestrator` to render `ChatLayout` inside provider.
- [ ] Add component tests; regression pass.

### M4 Quick Steps

- [ ] Implement workflow/upload hooks and update components.
- [ ] Write tests for recommendations/upload validation.
- [ ] Manual workflow + upload QA.

### M5 Quick Steps

- [ ] Remove dead code, ensure file size target.
- [ ] Update docs + localization resources.
- [ ] Final test run and smoke checklist.

---

This document captures the architectural intent, answered design questions, and step-by-step implementation plan so any engineer (including junior contributors) can execute the refactor with confidence.
