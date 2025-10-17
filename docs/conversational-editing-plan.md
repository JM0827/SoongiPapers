# Conversational Editing & Proofreading Implementation Notes

## Scope
Deliver the Milestone 3 outcomes from the chat UX plan:
- Authors can highlight text in Monaco and open a chat prompt pre-filled with the selection.
- Chat Orchestrator understands rewrite/rename/pronoun intents and routes them to backend helpers.
- Proofread results consolidate into a single recap card in chat with severity counts, exemplar issues, and CTAs to open the Proofread tab or request guidance.

## Integration Points
1. **Monaco selection bridge** (web/src/components/proofreading/DualEditorPanel.tsx)
   - Detect non-empty selection in modified editor.
   - Display inline toolbar (e.g., `수정 요청하기`, `이름 통일`, `성별 수정`).
   - Publish selection payload (text, range metadata, segment id) to a shared store.

2. **Chat entry injection** (web/src/components/chat/ChatOrchestrator.tsx)
   - Subscribe to selection store; when user taps inline action, insert a draft message with contextual hint ("선택한 문장을 어떻게 바꿀까요?").
   - Provide canned quick replies (`좀 더 서정적으로`, `간결하게`, `취소`).

3. **Intent handling**
   - Add local rewrite/name/pronoun handlers before escalating to LLM.
   - For rewrite requests, call new endpoint (`POST /api/translation/rewrite`) that uses existing translation services.
   - For name/pronoun normalization, reuse translation notes update API then trigger guard re-check.

4. **Proofreading recap card** (web/src/context/ProofreadIssuesContext.tsx + chat)
   - Derive aggregate stats (counts by severity, exemplar titles) from `useProofreadIssues` and enqueue a single chat message per run.
   - Provide CTAs that deep-link to the Proofread tab or trigger a summarized explanation in chat instead of duplicating every issue card.
   - Update or replace the recap card as the user resolves issues so chat reflects progress without flooding the transcript.

## Data Flow Diagram (high level)
```
[Monaco selection]
   ↓ (inline toolbar)
[editingCommand.store]
   ↓
[ChatOrchestrator quick-reply preset]
   ↓
[Intent router]
   → rewrite → /api/translation/rewrite
   → name/pronoun → translationNotes update + guard refresh
   → fallback → upstream LLM
   ↓
[Result confirmation message / Proofread recap status update]
   ↓
[Monaco apply via diffEditorRef]
```

## Open Questions
- Should rewrite results show diff before applying?
- How do we debounce repeated guard checks for batch replacements?
- Do we need undo history beyond Monaco's built-in undo stack?
- What cadence keeps the proofread recap card feeling fresh without jumping the scroll (replace-in-place vs. append)?

## Next Steps
1. Create `useEditingCommandStore` (Zustand) to share selection & action.
2. Implement inline toolbar in `DualEditorPanel`.
3. Extend `ChatOrchestrator` with selection-aware prompts & intent routing.
4. Surface proofread recap card with severity counts and deep-link CTAs.
5. Wire backend endpoints / placeholder mocks for rewrite + normalization.
