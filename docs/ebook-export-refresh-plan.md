# Ebook Export Tab Refresh – Implementation Plan

## 1. Context
- We are replacing the existing multi-section ExportPanel with a single-page "출간 준비(필수)" + "독자에게 알리기(선택)" layout.
- All backend integrations (ebook generation, cover regeneration/streaming, polling, downloads, translation selection) must stay intact; the change focuses on presentation and UX enhancements such as cover upload preview, clearer multi-format feedback, and consistent copy.
- No feature flags; the refreshed UI will become the default experience once merged.

## 2. Objectives
- Surface the required publishing checklist (translation, metadata, rights, format selection) in one concise card with clear gating rules and localized labels/aria attributes.
- Add an optional promotion section with tabs (표지 management + future marketing mock flows) without breaking existing cover workflows.
- Allow selecting both PDF and EPUB while the current backend still accepts only one format request at a time; provide sequential status chips so users see PDF → EPUB progress when both are chosen.
- Preserve and reuse all current data fetching, mutation handlers, polling, and translation selection so regressions are minimized.
- Capture lightweight telemetry (`ebook_generate_clicked`, `cover_upload_clicked`) to track engagement with the refreshed flow via a pluggable adapter.
- Map backend error codes to friendly Korean copy inside the essentials card.

## 3. Out of Scope
- Backend schema or endpoint changes (e.g., true multi-format generation in a single call).
- Persistent storage for manually uploaded covers (object URL only for now).
- Copy/locale updates outside the scope of labels touched in this refresh.
- Final UX for the translation picker modal (we reuse the existing implementation; deeper redesign deferred).

## 4. Milestones
1. **Scaffolding & Types**
   - Add new type helpers (`ebookTypes.ts`) and shared utilities (`canGenerate`, `langToCode`, error mappers, generation queues).
   - Create presentational components (`ExportEssentialsCard`, `CoverPreview`, `PromotionPanel`) with i18n-ready labels/aria.
   - Introduce telemetry adapter (`web/src/lib/telemetry.ts`).
2. **Integrate Into ExportPanel**
   - Map existing state into `EssentialsSnapshot`, wire `setSnap` to update legacy state (metadata, formats, rights, translation selection) and expose an `openTranslationPickerModal` handler for the new card.
   - Replace legacy JSX render with the new layout while leaving hooks, effects, handlers, and polling untouched.
   - Implement sequential generation queue for PDF/EPUB using current API calls, plus status chips that reflect per-format progress.
   - Emit telemetry events (`ebook_generate_clicked`, `cover_upload_clicked`) with context payloads.
3. **Validation & Polish**
   - Ensure cover upload preview lifecycle (create/revoke object URLs, allow removal) and reuse existing generate/regenerate handlers.
   - Apply error-code mapping for essentials card helper text; highlight missing required inputs in red with helper copy.
   - Verify translation modal trigger, status badges, error highlighting, CTA enablement rules, i18n key coverage, and aria labels/titles.
   - Run web unit tests (`npm test --prefix web`) and perform manual smoke (generate, download, cover regenerate, translation selection, telemetry logs).

## 5. Work Breakdown
- **Type Layer & Utilities**
  - `web/src/components/export/ebookTypes.ts`: define `TranslationSummary`, `MetadataDraft`, `EssentialsSnapshot`, `PromoState`, helper guards.
  - `web/src/components/export/errorMap.ts`: provide `mapGenerationError` mapping backend codes (e.g., `translation_missing`, `rights_missing`, `cover_generation_pending`).
  - `getGenerateQueue`, `formatProgressChips`, and `canGenerate` helpers.
- **Telemetry Adapter**
  - `web/src/lib/telemetry.ts`: expose `setTelemetry` and `trackEvent`; log to console when no implementation is injected.
  - Use in essentials card (`ebook_generate_clicked`) and cover preview (`cover_upload_clicked`).
- **UI Components**
  - `ExportEssentialsCard`: layout, validation styling, CTA area, progress chips, telemetry hook calls, localized strings/aria labels.
  - `CoverPreview`: upload + create/regenerate/remove controls, preview panel, removal button, telemetry for upload, i18n labels.
  - `PromotionPanel`: tabs, promo state mock (scene → video → SNS cards), reuse `CoverPreview` in the 기본 tab.
- **ExportPanel Integration**
  - Compose snapshot from existing store/state (`selectedTranslationId`, metadata, format flags, `rightsAccepted`).
  - Maintain bidirectional updates via `setSnap` (update metadata state, format toggles, rights flag, translation context).
  - Provide `onOpenTranslation` by wrapping the existing translation picker modal logic.
  - Build sequential generation runner (`handleGenerateSelected`) that updates status chips per format and falls back to PDF-only when only one is selected.
  - Reuse existing handlers for cover regeneration, downloads, translation fetching, and polling.
- **QA & Regression**
  - Regression test cover polling/generation/download flows.
  - Validate multi-format sequential generation with status chips and CTA gating.
  - Confirm translation selection, required-field validation, copy, and aria attributes.
  - Check telemetry console output in dev.

## 6. Dependencies & Assumptions
- Tailwind, shadcn/ui, and lucide-react are already configured; new components reuse existing style tokens.
- Translation picker modal logic is accessible (e.g., via `openTranslationPickerModal` or existing state toggles) and can be wrapped for the new card.
- Telemetry dispatcher can remain console-based until a real tracker is injected via `setTelemetry`.
- Backend endpoints remain unchanged and accessible in the dev environment.

## 7. Testing Strategy
- Automated: `npm test --prefix web` to ensure component and hook tests still pass.
- Manual smoke checklist:
  - Load export tab with/without translation; confirm gating messages and badge text.
  - Toggle metadata fields, rights acceptance, PDF/EPUB switches, verify CTA enablement, status chips, and telemetry logging.
  - Trigger PDF-only and PDF+EPUB generations; observe sequential chip transitions and resulting assets.
  - Upload/clear cover preview repeatedly; run regenerate to ensure polling still functions and telemetry fires.
  - Download latest ebook asset after generation and check translation picker modal invocation.
  - Validate error mapping by forcing representative backend error codes.

## 8. Risks & Mitigations
- **State drift between snapshot and legacy state** → centralize updates in `setSnap`, document mapping clearly.
- **Sequential generate double-submission** → guard queue (skip empty), await each call before continuing, update progress chips accordingly.
- **Object URL leaks** → revoke previous preview URL when setting or clearing cover uploads.
- **Telemetry noise** → keep payloads minimal, document event names, and log failures gracefully.
- **Copy/i18n drift** → store all new labels under existing localization utilities for future translation review.

## 9. Definition of Done
- 출간 준비 카드 shows translation badge (`{언어코드} 준비됨/누락`), red highlighting and helper text for missing required fields, localized labels/aria, and telemetry on generate.
- Generate button only enables when translation+metadata+rights are satisfied; PDF default on, EPUB optional, sequential status chips reflect progress for each selected format.
- 독자에게 알리기 카드: 기본(표지) tab supports upload/create/regenerate/remove with preview, object URL cleanup, telemetry, and i18n labels; 확장 홍보 tab allows scene → video → SNS mock transitions.
- Existing backend flows (polling, cover regeneration, ebook generation/download, translation selection modal) continue to work without regression.
- Error messages map backend codes to user-friendly Korean copy within the essentials card.

## 10. Open Questions
- Do we want to persist uploaded cover assets beyond the session in this iteration (still assumed "no")?
- Should telemetry events include additional context (projectId, format selection) from the outset?
- Any additional i18n review or translation support needed before shipping?

## 11. Implementation Notes (confirmed during planning)
- Telemetry helper lives in `web/src/lib/telemetry.ts`; production trackers can inject via `setTelemetry`.
- `onOpenTranslation` should wrap the existing translation picker modal (e.g., `openTranslationPickerModal()` or equivalent) so v4 UX can change the selected translation.
- Error mapping should start with the observed codes (`file_missing`, `translation_missing`, `rights_missing`, `cover_generation_pending`, `summary_unavailable`, `rate_limited`, `unauthorized`, fallback), and expand as new codes appear.
- Multi-format generation currently triggers sequential API calls (PDF first, then EPUB); future backend support for batch generation can replace the queue util without UI changes.

