# Soongi Pagers Chat UX Enhancement Plan

## Overview
## Current Implementation Gaps
- Greeting is a static paragraph; no localized quick actions or persona voice, so newcomers still feel lost.
- Workflow prompts are system-centric ("번역을 시작할까요?") and never reference translation notes or story tone, so critical facts go unconfirmed.
- Translation notes live only in the sidebar editor; the chat never surfaces character gender/name consistency or asks for confirmation.
- Stage updates arrive as multiple independent messages and aren’t synchronized with the header status badges.
- Chat lacks natural-language triggers for agents (translation, proofreading, QA, ebook), forcing users to hunt for buttons.
- Monaco editor selections can’t flow into chat rewrites, making conversational editing impossible.
- Localization is partial: templates mix Korean-only copy with English system prompts, ignoring the user’s language preference setting.

We want the Soongi Pagers assistant (“Soongi”) to feel like a collaborative partner for novel translation. The current chat mixes status dumps with sparse guidance, which overwhelms new users and hides the platform’s powerful agents. This document consolidates the UX strategies discussed so far into a cohesive plan, with special emphasis on respecting each user’s preferred language setting.

## Goals
- Deliver an onboarding experience that explains the translation journey in natural language.
- Keep conversation focused on actionable steps while avoiding notification fatigue.
- Expose every major agent capability (origin ingest, translation stages, proofreading, QA, ebook export) as a chat command.
- Support conversational editing (“이 문장을 이렇게 바꿔줘”, “사람 이름을 통일해줘”, “그는 여자가 맞아”) directly from selected text.
- Adapt tone and content to the user’s preferred language.
- Maintain a delightful, trustworthy persona that celebrates progress and anticipates needs.

## Target Personas
| Persona | Needs | Pain Today |
| --- | --- | --- |
| **First-time novelist** | Understand workflow, avoid jargon, follow 2–3 clear steps | “Too many system messages; not sure what to click.” |
| **Returning translator** | Quick access to recurring commands, progress summaries, memory prompts | Must drill into panels; no quick commands. |
| **Editor/Reviewer** | Resolve flagged issues fast, rewrite specific sentences in context | Proofread issues require panel-hopping; chat cannot mutate text. |

## Experience Pillars
1. **Conversational Journey**
   - Replace static tabs with a chat-visible stepper (Upload → Translate → Proofread → Export).
   - Soongi delivers a welcome message (in preferred language) with quick actions and a micro tour.
   - Each stage summary bundles status, key metrics, and a suggested next action button.
   - Tie the header status strip (Origin · Translation · Proofread · Quality) into chat: clicking a badge scrolls to the latest stage event, tooltip text respects the user’s locale, and badge colors mirror chat card states.
2. **Actionable Messages Only**
   - System messages require action or teach something useful. Minor telemetry moves to a timeline sidebar or a compact activity log.
   - Throttle automated bubbles (e.g., 5–10 sec debounce) and coalesce multiple events into one card when feasible.
   - Proofread findings ship as a single recap card with smart CTAs so the chat stays breathable while still prompting action.
3. **Conversational Editing Toolkit**
   - Selecting text in Monaco pops a contextual chat composer. Users can request rewrites, tone adjustments, or bulk replacements.
   - Chat commands trigger underlying services: `("이 문장을 이렇게 바꿔줘", selection)` → rewrite agent, `("사람 이름을 Minseo로 통일")` → name normalization agent.
4. **Memory & Style Awareness**
   - Soongi recaps stored style notes: “You asked for formal honorifics—applied already.”
   - When conflicts arise (e.g., gender mismatch), Soongi proactively prompts corrections.
5. **Language Preference Compliance**
   - All assistant-generated text, including button labels, matches the user’s language setting.
   - Fallback logic ensures consistent language even when responses pull in agent output.

## Key Features & Flows
### 1. First-Run Onboarding
- Auto-show Soongi message: “안녕하세요! 처음이시군요. 원문을 업로드하면 제가 번역부터 교정까지 도와드릴게요.”
- Provide quick replies: `원문 업로드`, `둘러보기`.
- For existing users, show a concise greeting with recent activity and CTA to resume work.

### 2. Stage Progress Cards
- Single card per job stage updated in place.
- Message example (Korean locale):
  > 🔄 **스타일 패스 진행 중** (2/4 단계 완료, 예상 3분)
  > 버튼: `중간 결과 보기`, `QA 패스 시작`
- Once finished, Soongi posts a celebratory summary with next step chips.

### 3. Conversational Editing
- Select text → floating toolbar offers `수정 요청하기` (Opens chat composer auto-contextualized with selection).
- Example command:
  > 사용자: “이 부분을 더 서정적으로 바꿔줘.”
  > Soongi: “이 문장을 이렇게 제안해요: … 적용할까요?” Buttons: `적용`, `수정 요청`, `취소`.
- Provide global commands: `이름 Minseo로 통일`, `그녀/그` pronoun swap.

### 4. Proofreading & QA as Chat
- Post a single **Proofread recap card** when a run completes (or new findings arrive). The card shows severity totals, highlights 1–2 exemplar issues, and clarifies that detailed cards live in the Proofread tab.
- Chips include: `Proofread 열기`, `주요 이슈 설명`, `검수 완료 처리`. Selecting them either deep-links into the Proofread view or triggers a short advisory message in chat.
- Allow users to request follow-up detail (e.g., “심각 등급만 알려줘”) through natural language; the assistant responds with concise bullet summaries without flooding the timeline.
- When the user resolves issues in the Proofread tab, the chat recap updates its status badge (e.g., “3/12 해결됨”) so progress stays visible without duplicating every card.

### 5. Memory & Tips
- Daily tip block (optional): miniature card with writing/translation advice.
- “Style snapshot” command to store preferences (`분위기: 잔잔한 서정`). Soongi references snapshots in future suggestions.

### 6. Message Tone & Language Rules
- Use preference key from My Settings when crafting responses.
- For non-supported locales, default to English and label that fallback.
- Keep sentences short, friendly, and specific. Avoid cross-language mix unless quoting source/target text.

## UX Artifacts (Future Work)
- Wireframes: chat layout with stage stepper and quick commands.
- Example conversation transcripts in KO and EN locales.
- Updated empty states for editors and sidebar.

## Technical Considerations
- **Localization:** Extend i18n framework to chat templates; ensure runtime agent outputs pass through translation layer when safe (or are annotated if raw).
- **Intent Routing:** Enhance `ChatOrchestrator` to map natural language to agents; consider lightweight classification (rule-based to start, LLM fallbacks later).
- **State Management:** Centralize stage status so chat, timeline, and UI panels read consistent data.
- **Rate Limiting:** Chat service must manage message queueing to prevent floods; maintain context window of last actionable message.
- **Analytics:** Track conversions per command, message engagement, quick-reply usage, locale coverage.

## Rollout Plan
1. **Foundation (Milestone 0)**
   - Implement language-aware templates.
   - Create quick-reply infrastructure and stage card component.
2. **Guided Onboarding (Milestone 1)**
  - Ship first-run flow with localized quick actions (Upload, Tour) and clear guidance for starting translation.
3. **Conversational Stage Control (Milestone 2)**
   - Map chat commands to translation/QA agents.
   - Bundle stage progress updates.
   - *Status:* Translation, proofread, quality, upload, status, cancel, and ebook intents now route before the LLM with localized context. Ebook export still requires automation (see TODO in `server/routes/chat.ts`).
4. **Editing & Proofreading (Milestone 3)**
   - Integrate Monaco selection bridge.
   - Present a single proofread insight card that rolls up severity counts, spotlights representative issues, and deep-links to the Proofread tab for fixes.
5. **Memory & Advanced Commands (Milestone 4)**
   - Add name/pronoun normalization via chat.
   - Surface style snapshot reminders.
6. **Polish & Feedback (Milestone 5)**
   - Add daily tips, celebratory animations, help drawer.
   - Gather user feedback (NPS within chat) and iterate.

## Success Metrics
- ≥80% of new users upload origin within first session after onboarding flow.
- ≥30% increase in usage of quick action buttons vs. manual navigation.
- ≥60% of proofread review sessions started from the chat summary card CTA.
- Average satisfaction rating (“Was Soongi helpful?” prompt) ≥4/5.
- Reduction in system-only messages per run (target: ≤5 per translation).

## Open Questions
- Should we allow voice or audio commands in the chat composer?
- What level of translation memory editing do we expose directly in chat (e.g., user editing memory entries)?
- How will we localize agent-generated glossaries or QA logs quickly—human review or automated translation with disclaimers?

---
This plan ensures Soongi Pagers delivers a chat-centric, language-aware, end-to-end novel translation experience that feels as intuitive as ChatGPT but tailored for literary workflows.
