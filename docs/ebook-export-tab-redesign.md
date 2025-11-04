# Ebook Export Tab – Modularization & UX Refresh Plan

## 1. Context
- `ExportPanel.tsx` is 982 lines long and blends data fetching, generation workflows, cover management, translation selection UI, telemetry, and presentation (`web/src/components/export/ExportPanel.tsx`).
- Even after introducing `ExportEssentialsCard`, `PromotionPanel`, and supporting utilities, the panel still owns:
  - Cover fetching/preview lifecycle (`web/src/components/export/ExportPanel.tsx:200-360`).
  - Metadata hydration and readiness evaluation (`web/src/components/export/ExportPanel.tsx:352-455`).
  - Generation queue management and telemetry (`web/src/components/export/ExportPanel.tsx:582-639`).
  - Cover upload/regenerate handlers (`web/src/components/export/ExportPanel.tsx:640-706`).
  - Translation picker modal markup (`web/src/components/export/ExportPanel.tsx:820-968`).
- This coupling makes the tab difficult to test, causes regressions during UI tweaks, and hides business invariants across scattered `useEffect`s.

## 2. Objectives
1. Modularize the ebook export tab so fetch/update logic lives in reusable hooks and domain-specific controllers.
2. Convert `ExportPanel.tsx` into a thin composition layer (<250 lines) that wires context, hooks, and presentational components.
3. Maintain existing behaviors (multi-format generation, translation picker, cover workflow, telemetry) while making state transitions testable.
4. Improve UX resilience: translation dialog as standalone component, consistent error surfacing, upload/preview flows guarded by single source of truth.

## 3. Non-Goals
- Changing backend contracts (`api.fetchCover`, `api.generateEbook`, etc.).
- Altering telemetry event schema (`ebook_generate_clicked`, `cover_upload_clicked`).
- Replacing React Query, Zustand, or existing type definitions in `ebookTypes.ts`.
- Implementing brand-new features (e.g., persistent cover uploads, marketing automation). Focus is structural refactor + minor UX cleanup.

## 4. Pain Points & Evidence
| Concern | Reference | Impact |
| ------- | --------- | ------ |
| Massive component with mixed concerns | `ExportPanel.tsx:1-982` | Difficult onboarding, high regression risk. |
| Cover fetch & preview logic tangled with UI | `ExportPanel.tsx:200-360`, `ExportPanel.tsx:640-707` | Hard to reuse in other surfaces; object URL cleanup scattered. |
| Generation workflow embedded in component | `ExportPanel.tsx:582-639` | No unit coverage; difficult to mock for tests. |
| Translation picker rendered inline | `ExportPanel.tsx:820-968` | Prevents reuse; modal-specific state inflates component. |
| Duplicated metadata hydration logic | `ExportPanel.tsx:352-420` | Hard to validate field defaults; no test coverage. |
| Multiple `useEffect`s performing data fetch | `ExportPanel.tsx:215-360` | Fetching logic untestable; concurrency issues hard to reason about. |

## 5. Target Architecture
```
ExportPanel (thin)
├── EbookExportProvider (context)
│   └── useEbookExportController  # orchestrates data loading & mutations
├── useEbookGeneration            # format queue, runGenerate, telemetry
├── useCoverManager               # cover fetch/preview/upload/regenerate
├── useTranslationPicker          # translation options + dialog state
├── useMetadataDraft              # default hydration, change handling
├── ExportLayout                  # layout shell
│   ├── ExportEssentialsCard      # already presentational
│   ├── PromotionPanel            # reuses CoverPreview props
│   ├── ExportSummaryCard         # extracted from summary section
│   └── TranslationPickerDialog   # new component
└── lib/ebook (helpers)           # readiness, formatting (already exists)
```

### 5.1 Context Provider
**Location**: `web/src/contexts/EbookExportContext.tsx`

**Value Shape**:
```ts
interface EbookExportContextValue {
  project: { id: string | null; title: string; targetLang: string };
  controller: ReturnType<typeof useEbookExportController>;
  generation: ReturnType<typeof useEbookGeneration>;
  cover: ReturnType<typeof useCoverManager>;
  metadata: ReturnType<typeof useMetadataDraft>;
  translations: ReturnType<typeof useTranslationPicker>;
  readiness: ReturnType<typeof evaluateReadiness>;
  ui: {
    isLoading: boolean;
    error: string | null;
  };
}
```

### 5.2 Hook Specifications
#### 5.2.1 `useEbookExportController`
- **File**: `web/src/hooks/export/useEbookExportController.ts`
- **Inputs**: `token`, `projectId`, `api`, query client, `onTelemetryEvent?`.
- **Responsibilities**:
  - Load cover info, ebook details, translation options.
  - Expose `refresh` helpers (cover/details/translations).
  - Maintain `result`, `error`, `isLoading` state.
  - Provide `invalidateProjectQueries` wrapper.
  - Trigger telemetry events via optional callback; default to current `trackEvent` usage.
- **Outputs**:
```ts
interface EbookExportController {
  state: {
    result: EbookResponse | null;
    isLoading: boolean;
    error: string | null;
  };
  actions: {
    fetchCover: () => Promise<void>;
    fetchDetails: () => Promise<void>;
    loadTranslations: (preferredId?: string | null) => Promise<void>;
  };
}
```

#### 5.2.2 `useEbookGeneration`
- **File**: `web/src/hooks/export/useEbookGeneration.ts`
- **Dependencies**: controller actions, metadata snapshot, translation summary, `api.generateEbook`, `getGenerateQueue`.
- **Responsibilities**:
  - Manage `formats` state (PDF/EPUB toggles) and `rightsAccepted`.
  - Run sequential generation queue; expose progress chips and download metadata.
  - Emit telemetry on generation start/failure.
- **Outputs**:
```ts
interface EbookGeneration {
  formats: { pdf: boolean; epub: boolean };
  setFormat: (format: GenerationFormat, value: boolean) => void;
  rightsAccepted: boolean;
  setRightsAccepted: (value: boolean) => void;
  progress: GenerationProgressChip[];
  run: () => Promise<void>;
  disabled: boolean;
  buildState: BuildState;
  download: {
    run: () => Promise<void>;
    available: boolean;
    label: string;
    loading: boolean;
    error: string | null;
  };
}
```

#### 5.2.3 `useCoverManager`
- **File**: `web/src/hooks/export/useCoverManager.ts`
- **Responsibilities**:
  - Fetch cover sets, manage preview object URLs, uploaded file state, regenerate flow.
  - Centralize `fallbackCover` selection.
  - Provide stable props for `PromotionPanel`.
- **Outputs**:
```ts
interface CoverManager {
  imageSrc: string;
  isGenerating: boolean;
  isRegenerating: boolean;
  upload: (file: File) => void;
  removeUpload: () => void;
  regenerate: () => Promise<void>;
  error: string | null;
  previewLoading: boolean;
}
```

#### 5.2.4 `useTranslationPicker`
- **File**: `web/src/hooks/export/useTranslationPicker.ts`
- **Responsibilities**:
  - Manage translation options, selected ID, dialog open state.
  - Provide derived summary (`TranslationSummary`), recommended flag.
  - Expose `open`, `close`, `refresh` functions.
- **Outputs**:
```ts
interface TranslationPicker {
  options: ProjectTranslationOption[];
  selectedId: string | null;
  setSelectedId: (id: string) => void;
  isOpen: boolean;
  open: () => void;
  close: () => void;
  refresh: () => Promise<void>;
  loading: boolean;
  error: string | null;
  summary: TranslationSummary;
}
```

#### 5.2.5 `useMetadataDraft`
- **File**: `web/src/hooks/export/useMetadataDraft.ts`
- **Responsibilities**:
  - Initialize metadata fields using project/profile defaults.
  - Provide change handlers and computed readiness input for `evaluateReadiness`.
  - Synchronize with `EssentialsSnapshot` updates.
- **Outputs**:
```ts
interface MetadataDraftHook {
  draft: MetadataDraft;
  updateFromSnapshot: (snap: EssentialsSnapshot) => void;
  applyDefaults: (defaults: MetadataDefaults) => void; // invoked on mount & when data changes
}
```

### 5.3 Presentational Components
| Component | Responsibilities | Notes |
| --------- | ---------------- | ----- |
| `ExportLayout.tsx` | Column layout, spacing, passes context slices to children. | Similar to ChatLayout structure. |
| `ExportSummaryCard.tsx` | Extracted from current summary section (lines `824-872`). | Accept `ebookDetails`, `metadataDraft`, loading/error flags. |
| `TranslationPickerDialog.tsx` | Modal UI currently inline; receives `TranslationPicker` output & localization fn. |

Existing `ExportEssentialsCard`, `PromotionPanel`, `CoverPreview` remain presentational; adjust props to match new hooks.

## 6. Milestones & Deliverables
| Milestone | Scope | Key Tasks | Validation |
| --------- | ----- | --------- | ---------- |
| **M1 – Controller & Context Scaffolding** | Introduce context + `useEbookExportController`. `ExportPanel` still renders old JSX but consumes controller for fetches. | Create `EbookExportContext`, migrate data fetch `useEffect`s into controller, expose hooks. | Unit tests for controller (mock API), manual regression of loading states. |
| **M2 – Generation & Metadata Hooks** | Extract `useEbookGeneration`, `useMetadataDraft`; wire into `ExportEssentialsCard`. | Move format toggles, rights, run queue, download logic. Update card props. | Hook tests covering queue progress, download fallback; manual generate/download QA. |
| **M3 – Cover & Translation Hooks** | Implement `useCoverManager`, `useTranslationPicker`; detach modal markup into `TranslationPickerDialog`. | Remove inline modal from panel; update `PromotionPanel` props. | Hook tests for upload/remove/regenerate; translation picker tests for selection + refresh. |
| **M4 – Presentational Layout Split** | Introduce `ExportLayout`, `ExportSummaryCard`; reduce `ExportPanel` to context provider + layout. | Ensure new layout matches existing Tailwind classes; update imports. | Component snapshot tests; manual visualization. |
| **M5 – Cleanup & Docs** | Delete obsolete state, ensure file size target. Update docs. | Document new structure in `docs/ebook-export-tab-redesign.md` & `docs/0.사용자인터페이스.md`. | Run `npm test --prefix web`, full manual smoke checklist. |

Estimated timeline: 2d per milestone (M1–M4), 1d for M5 + buffer (total ~9 days).

## 7. Testing Strategy
- **Unit / Hook Tests** (`web/src/hooks/export/__tests__/`):
  - `useEbookExportController.test.ts`: cover success/failure fetches, telemetry callback invocation, query invalidation.
  - `useEbookGeneration.test.ts`: verify sequential queue, error handling, disabled states.
  - `useCoverManager.test.ts`: object URL handling, regenerate auth failure, preview fallback selection.
  - `useTranslationPicker.test.ts`: dialog open/close, refresh with recommendation, error propagation.
  - `useMetadataDraft.test.ts`: default hydration, snapshot merge semantics.
- **Component Tests**:
  - `TranslationPickerDialog.test.tsx`: radio selection, recommended badge rendering.
  - `ExportSummaryCard.test.tsx`: loading vs data states.
- **Manual QA** (per milestone):
  1. Load export tab w/ project lacking translation → verify gating copy unchanged.
  2. Select translation via dialog; ensure card updates and modal closes.
  3. Trigger PDF-only & PDF+EPUB generations; observe sequential chips and follow download.
  4. Upload/replace cover (click + drag); regenerate cover while upload pending.
  5. Validate external download link fallback when `downloadAssetId` missing.
  6. Confirm telemetry events still logged in console.

## 8. Risks & Mitigations
| Risk | Mitigation |
| ---- | ---------- |
| Regression in generation queue due to refactor | Keep existing `getGenerateQueue` util; add regression tests comparing chip transitions. |
| Object URL leaks if hook mismanages cleanup | Centralize cleanup in `useCoverManager` with `useEffect` return. Add tests verifying revocation. |
| Translation picker losing recommendation defaults | Ensure hook accepts `preferredId` and reuses existing logic from `loadTranslationOptions`. |
| Increased renders due to context | Memoize context slices; expose selectors to avoid re-render storms. |
| Localization keys drift | Reuse existing `t('export.*')` keys; add PR checklist verifying new keys registered. |

## 9. Definition of Done
- `ExportPanel.tsx` streamlined (<250 lines) containing only provider + layout assembly.
- New hooks under `web/src/hooks/export/` with comprehensive unit tests.
- `EbookExportContext` adopted by all export components; no data-fetching `useEffect` remains in presentational code.
- Translation picker, summary card, promotion panel operate via context-driven props.
- Documentation updated (this file + UI overview); CI (`npm test --prefix web`) passes; manual smoke checklist signed off.

## 10. Implementation Checklist (Per Milestone)
### M1
- [ ] Scaffold `EbookExportContext` and wrap existing panel.
- [ ] Implement `useEbookExportController`, move fetch logic, remove associated `useEffect`s.
- [ ] Expose controller state through context; adjust panel to read data from hook.
- [ ] Add controller unit tests.

### M2
- [ ] Build `useMetadataDraft` using current hydration logic.
- [ ] Build `useEbookGeneration`, rewire `ExportEssentialsCard` props.
- [ ] Remove `handleGenerateSelected`, `handleDownload`, `handleToggleFormat`, etc., from panel.
- [ ] Unit tests for generation hook + metadata hook.

### M3
- [ ] Implement `useCoverManager`, `useTranslationPicker`.
- [ ] Extract modal to `TranslationPickerDialog.tsx` consuming hook output.
- [ ] Update `PromotionPanel` props to use cover manager API.
- [ ] Hook tests for cover + translation flows.

### M4
- [ ] Add `ExportLayout.tsx` and `ExportSummaryCard.tsx`.
- [ ] Move summary markup and layout wrappers into new components.
- [ ] Ensure css classes replicate existing look; update exports.
- [ ] Component tests where valuable.

### M5
- [ ] Remove unused imports/state from `ExportPanel.tsx`.
- [ ] Update docs (`docs/0.사용자인터페이스.md`, this plan with status).
- [ ] Final test run + manual QA checklist.

---
This plan provides the architectural direction, detailed hook/component contracts, milestone breakdown, and verification strategy so engineers of all experience levels can execute the ebook tab improvement with confidence.
