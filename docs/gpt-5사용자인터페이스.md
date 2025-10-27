# GPT-5 기반 사용자 대화 인터페이스 전환 설계서

## 1. 배경 및 목표
- 현재 Studio Chat, Intent 라우터, 편집 보조 명령은 `gpt-4o`/`gpt-4o-mini`를 기반으로 `chat.completions` API를 호출하여 JSON 응답을 파싱함.
- GPT-5 Responses API는 도구 호출, 구조화 출력, 장문 컨텍스트에서 더 나은 일관성과 Reasoning Effort 제어를 제공하므로, 사용자 대화 경험(컨시어지 답변, 작업 오케스트레이션, 실시간 편집 제안)을 향상시키기 위해 GPT-5로 전환하고자 함.
- 목표는 **Chat 전반(대화 응답, 의도 분류, 엔티티 추출, 편집 제안)을 GPT-5 계열 모델로 옮기고**, Responses API 규격/파라미터 가이드(verbosity/reasoning/max_output_tokens)를 준수하면서 UI/백엔드 호환성을 유지하는 것.

## 2. GPT-5 마이그레이션 체크리스트
1. **모델 식별자 교체**: `CHAT_MODEL`, `INTENT_CLASSIFIER_MODEL`, Spec/모델 리스트에서 gpt-4o 계열 → `gpt-5`, `gpt-5-mini`, `gpt-5-nano`.
2. **Responses API 도입**: 모든 `openai.chat.completions.create` 호출(대화, 의도 분류, 엔티티 추출, 편집 명령)을 `responses.create()`로 전환.
3. **새 파라미터 적용**: `temperature/top_p` 제거, `verbosity`, `reasoning.effort`, `max_output_tokens` 채택.
4. **스트리밍 대응**: 대화 응답은 스트리밍(`responses.stream`) 도입 준비, 프런트의 typing indicator와 통합.
5. **구조화 출력 강화**: JSON Schema 기반 `response_format` 적용, 파싱 실패 시 재시도/백오프.
6. **도구 호출 확장성**: GPT-5의 free-form tool call을 향후 UI 액션 실행(예: "action:viewTranslation")과 연동할 수 있도록 설계.
7. **에러/백오프 정책**: GPT-5에서 발생할 수 있는 파라미터/토큰 예산 오류에 대비해 effort 조정 및 모델 fallback(`gpt-5-mini`) 로직 정의.
8. **토큰 예산 관리**: 메시지 길이에 따라 `max_output_tokens` 동적 설정, 대화 응답 길이 제한 준수.
9. **관측 지표 확장**: 모델 ID, effort/verbosity, 스트리밍 소요 시간, 액션 제안 정확도 등 분석 지표 추가.
10. **환경/Spec 문서화**: 새 ENV/옵션을 레포 문서와 운영 가이드에 반영.

## 3. 영향 범위 분석
| 컴포넌트 | 현재 구현 | GPT-5 전환 영향 |
| --- | --- | --- |
| `/api/chat` 라우트 (`server/routes/chat.ts`) | Chat Completions, JSON.parse 결과 | Responses API, verbosity/effort, 스트리밍, JSON Schema 검증, fallback 처리 |
| 의도 분류기 (`server/services/intentClassifier.ts`) | Chat Completions + temperature | Responses API, `gpt-5-mini` preset, confidence 재보정 |
| 엔티티 추출 (`ENTITY_PROMPT`) | Chat Completions | Responses API, stricter schema, 재시도 로직 |
| 편집 보조 (`server/routes/editing.ts`) | Chat Completions | Responses API, `verbosity='low'` + `max_output_tokens` 제한, 응답 스키마 강화 |
| 모델 리스트 (`server/services/modelService.ts`) | gpt-4o 계열 옵션 | 기본 추천을 `gpt-5`로 설정, UI 정렬/설명 업데이트 |
| 프런트 `ChatOrchestrator` & `api.chat` | 단일 응답, `reply/actions` JSON 소비 | 스트리밍 수신, 응답 메타(모델/effect) 반영, 에러/재시도 UI |
| 로깅/분석 (`recordChatLog`, `ChatMessageModel`) | 모델명/usage 미포함 | GPT-5 파라미터/토큰/재시도 기록, 타입 변경 |
| 모델 선택 UI (`useModelSelection`) | legacy 목록 | GPT-5 default, effort/latency 표시 |
| Quick Replies & Action Chips | 텍스트 기반 | GPT-5 응답에 포함된 `actions`/tool-call과 동기화 |

## 4. 설계 상세
### 4.1 환경 & 구성
- `.env` 업데이트:
  - `CHAT_MODEL=gpt-5`
  - `INTENT_CLASSIFIER_MODEL=gpt-5-mini`
  - 새 키: `CHAT_VERBOSITY=medium`, `CHAT_REASONING_EFFORT=medium`, `CHAT_MAX_OUTPUT_TOKENS=900`
  - 엔티티 추출/편집용 각 preset (`CHAT_ENTITY_MODEL=gpt-5-mini`, `EDITING_ASSIST_MODEL=gpt-5-mini`).
- `server/services/modelService.ts`의 `BASE_MODELS`에 GPT-5 계열 설명/latency 조정, UI에서 GPT-5를 기본 추천으로 노출.

### 4.2 `/api/chat` 주요 호출 전환
- **대화 본문**
  ```ts
  const response = await openai.responses.create({
    model,
    verbosity,
    reasoning: { effort },
    max_output_tokens,
    response_format: { type: 'json_schema', json_schema: chatReplySchema },
    input: buildChatMessages(messages),
  });
  ```
- `chatReplySchema` 정의: `{ reply: string, actions: Action[], profileUpdates?: object }`.
- 스트리밍 지원: 프런트에서 SSE/WebSocket 없이 fetch streaming → `ReadableStream` 사용, 부분 JSON 버퍼링 후 완료 시 파싱.
- 재시도 정책: 1차 실패 시 effort 증가 → 2차 `gpt-5-mini` fallback, 응답 실패 시 사용자가 다시 시도하라는 메시지 반환.
- 응답 메타 기록: `model`, `verbosity`, `reasoning.effort`, `retryCount`, `latencyMs`.

### 4.3 의도 분류/엔티티 추출
- `intentClassifier` Responses API로 전환, 스키마 기반(`intent`, `confidence`, `rerun`, `label`, `notes`).
- 파라미터 preset: `verbosity='low'`, `reasoning.effort='minimal'`, `max_output_tokens=256`.
- confidence 재보정: GPT-5의 확신치 분포 확인 후 threshold 조정 (`CHAT_INTENT_CONFIDENCE`).
- 엔티티 추출 호출도 Responses API + JSON Schema (`title/author/context/translationDirection/memo`). 실패 시 로그 + 무시.

### 4.4 편집 보조 API
- `server/routes/editing.ts`에서 Responses API 사용, 스키마 `{ updatedText, explanation?, warnings? }`.
- `max_output_tokens`를 selection 길이에 비례하여 동적 계산 (예: `ceil(selection.length / 3.5) + margin`).
- effort/verbosity: `verbosity='low'`, `reasoning.effort='low'` 기본, 고난이도 요청 시 UI에서 조정 가능하도록 투명화.

### 4.5 프런트엔드 통합
- `api.chat`에서 스트리밍 응답 수신 → progressive rendering (typing indicator → chunk append → 최종 JSON 파싱).
- `ChatOrchestrator`:
  - 모델 메타 표시(예: "GPT-5 · reasoning: medium").
  - 오류/재시도 UX 개선.
  - `actions` 목록에 tool-call 확장(예: GPT-5가 반환한 `open_document`).
- 모델 선택 모달: GPT-5 기본, mini/nano 옵션에 latency 표시, Responses API 전용 옵션만 노출.

### 4.6 로깅 & 모니터링
- `ChatMessageModel`에 `metadata` 필드 확장: `{ model, verbosity, reasoningEffort, tokens: { input, output }, retries, streaming: boolean }`.
- `chat.log` 엔드포인트도 신규 필드 반영.
- Observability 대시보드: intent accuracy, action adoption, GPT-5 latency.

### 4.7 스트리밍 & 청크 처리
- Responses API streaming을 `ReadableStream`으로 받아서 incremental JSON 버퍼 구현 (`jsonl` 구문 사용).
- 프런트 typing indicator/auto-scroll 동작 업데이트.
- 서버에서 스트리밍을 지원하기 위해 Fastify reply.raw 사용 + 헤더(`Transfer-Encoding: chunked`).

### 4.8 Tool Call 확장 계획
- GPT-5 tool call payload를 action dispatcher로 변환하는 변환기 작성 (예: `toolCall: { name: "startProofread", arguments: {...} }`).
- 초기 릴리스에서는 JSON 응답 기반 액션을 유지하되, schema 확장 필드(`tool_calls`) 추가.

## 5. 리스크 및 대응
| 리스크 | 대응 |
| --- | --- |
| Responses API 파싱 실패 | JSON Schema 검증 + 재시도, 로그에 raw payload 샘플 저장 |
| 스트리밍 도중 연결 종료 | client retry with exponential backoff, partial content 무시 |
| 비용/latency 상승 | Quick intents/엔티티는 `gpt-5-mini`로, effort 자동 조정 |
| 모델 fallback 실패 | gpt-4o emergency fallback 경로 유지 (feature flag) |
| 프런트 호환성 | 스트리밍/메타 필드 추가 시 타입 가드, 스냅샷 테스트 |
| 사용자 데이터 노출 | 로그에 PII 제거, profileUpdates sanitation 유지 |

## 6. 구현 Milestone
1. **M0 – 준비 (0.5주)**: SDK 업데이트, ENV 초안, 스트리밍 POC, 테스트 하네스 준비.
2. **M1 – 의도/엔티티 전환 (0.5주)**: Responses API 적용, schema/재시도, confidence 재보정.
3. **M2 – 대화 본문 전환 (1주)**: `/api/chat` 리팩터, 스트리밍, actions schema 업데이트.
4. **M3 – 편집 보조/기타 엔드포인트 (0.5주)**: `/api/editing` 등 부가 인터페이스 전환.
5. **M4 – 프런트 통합 (1주)**: 스트리밍 UI, 모델 선택, 메타 표시.
6. **M5 – Observability & Pilot (0.5주)**: 로그/메트릭 확장, 파일럿 프로젝트에서 A/B.
7. **M6 – 전체 롤아웃 (0.5주)**: KPI 검증(응답 품질/intent 정확도), gpt-4o sunset 계획.

## 7. 추가 확인 사항
- Responses API를 공통 래퍼(`server/services/openaiClient.ts` 등)로 분리해 중복 제거 여부 검토.
- 모델 명세/권한 정책이 변경될 경우(예: GPT-5 preview), fallback 전략 문서화.
- 프런트 i18n 문자열 업데이트: GPT-5 관련 안내, latency 안내.
- 챗봇 액션과 Workflow 이벤트 간 동기화 테스트 강화.
- Free-form tool call 통합, multi-turn memory 확장 등 후속 과제 backlog에 기록.

---
**담당**
- Owner: Conversation Experience Team
- 리뷰어: Product AI Leads, Platform Infra
- 최초 작성: 2025-01-14
- 수정 기록: 전환 진행 중 수시 업데이트 예정
