# 챗 시스템 개선 계획

## 1. 목표
- 사용자 질의에 대한 단답/진행 상황 안내라는 본래 목적에 맞춰 챗봇 구조를 단순화한다.
- 메시지 중복, 스트림 400 오류 등 현재 빈번하게 발생하는 결함을 제거하고 회복력 있는 파이프라인을 구축한다.
- 서버/클라이언트가 공유하는 스키마·상태 관리 계층을 정리하여 유지보수성을 높인다.

## 2. 현행 구조 주요 문제
| 구분 | 증상 | 영향 |
| --- | --- | --- |
| 메시지 상태 중복 | 히스토리 페치 시 `setMessages(history)`로 전체 스테이트를 덮어써 로컬에서 전송한 메시지가 두 번 렌더링됨 | 사용자 경험 저하, 디버깅 어려움 |
| 비정형 파이프라인 | `postProcessChatPayload`가 응답 스키마 정규화, DB 업데이트, 이벤트 발행을 한 함수에서 처리 | 변경 시 부작용 발생, 테스트 곤란 |
| Responses 스키마 취약성 | GPT-5 `json_schema` strict 모드에 맞추기 위해 서버/클라이언트 각지에서 핫픽스 | 빈번한 400 오류, 유지비용 증가 |
| 거대한 UI 컴포넌트 | `ChatOrchestrator`가 3,000+ 라인을 담당, 렌더/네트워크/액션 로직 혼재 | 구조 파악 어렵고 회귀 위험 증가 |
| 스트리밍 실패 복구 미비 | SSE 오류 발생 시 동일 메시지가 재전송되거나 스테이트가 꼬임 | 신뢰성 저하 |

## 3. 개선 전략

### 3.1 단일 진실 원칙 적용한 메시지 스토어
- **도입 요소**: `useChatMessages` 훅 (zustand 혹은 React context 기반), `ChatMessageStore` 타입.
- **핵심 로직**:
  1. 사용자 전송 시 임시 ID(`temp-uuid`)로 optimistic message 추가.
  2. 서버 응답 도착 후 서버 ID로 교체/머지.
  3. 히스토리 로딩은 `upsert` 전략(존재 여부 체크 후 추가)만 수행.
- **효과**: 메시지 중복/순서 꼬임 방지, SSE/REST 경로 통합.

### 3.2 오케스트레이터 분리
- `ChatOrchestrator` → 다음 컴포넌트로 분해
  - `ChatTimeline`: 메시지 목록 렌더
  - `ChatComposer`: 입력/버튼 UI
  - `ChatStatusPanel`: 추천 카드/진행 상황
  - `useChatStreaming`: SSE 구독 및 상태머신
- **장점**: 각 영역 테스트 가능, 스트림/로그 로직을 별도 훅에서 관리.

### 3.3 서버 응답 파이프라인 모듈화
- `server/services/chatResponder.ts` 신설
  - 입력 정규화(`buildSystemMessages`)
  - Responses 실행(`executeChatResponses`)
  - 후처리(`applyProfileUpdates`, `persistIntentSnapshot`)
- Responses 스키마는 Zod + `zod-to-json-schema`로 생성하여 서버/클라이언트가 동일 타입 사용.
- **효과**: 스키마 변경 시 한 곳에서 대응, 테스트 용이.

### 3.4 스트리밍 오류 복구 전략
- SSE 이벤트 타입 정리: `status`, `delta`, `complete`, `error`.
- `chatStream`에서 오류 발생 시:
  1. 임시 메시지를 에러 상태로 전환 (badge + retry CTA)
  2. 자동 폴백 REST 호출은 제거, 사용자가 명시적으로 재시도
- **효과**: 자동 중복 전송 방지, UX 일관성 향상.

### 3.5 테스트 & 관측 강화
- 서버: `POST /api/chat` 통합 테스트(의도 분류, 프로필 업데이트, 히스토리 저장 검증).
- 클라이언트: `useChatMessages` 스토어와 `useChatStreaming` 훅을 Vitest로 모킹, 스트림/오류 시나리오 검증.
- 로깅: SSE `meta`에 모델/latency를 유지하되, tool call 등 미사용 필드는 제거.

## 4. 구현 로드맵
| 단계 | 범위 | 산출물 |
| --- | --- | --- |
| M1 | 메시지 스토어 도입 & 히스토리 로딩 개편 | 새로운 `useChatMessages` 훅, 기존 `setMessages` 제거 |
| M2 | 오케스트레이터 컴포넌트 분해 | `ChatTimeline`, `ChatComposer`, `useChatStreaming` |
| M3 | 서버 응답 모듈화 & Zod 스키마 도입<br/>**+ 서버 JSON 액션 스키마 정리** | `chatResponder.ts`, 공유 타입 패키지 (`packages/chat-schema`), `responsesSchemas.ts` |
| M4 | 스트리밍 오류 UX 개선 | SSE 이벤트 재정의, 클라이언트 오류 처리 업데이트 |
| M5 | 테스트 & 모니터링 정비 | 서버 통합 테스트, 프런트 훅 테스트, 대시보드 필드 정리 |

### 4.1 단계별 주요 수정 파일
- **M1 – 메시지 스토어 & 히스토리 개편**
  - `web/src/components/chat/ChatOrchestrator.tsx`
  - `web/src/hooks` (신규 `useChatMessages.ts`)
  - `web/src/store/chatAction.store.ts` (필요 시 통합)
  - ✅ 적용 현황: `useChatMessages` 훅을 도입해 낙관적 메시지 업데이트와 히스토리 병합을 단일 스토어로 처리하고, `ChatOrchestrator` 내 `setMessages` 의존성을 제거했다.
- **M2 – 컴포넌트 분해**
  - `web/src/components/chat/ChatTimeline.tsx` (신규)
  - `web/src/components/chat/ChatComposer.tsx` (신규)
  - `web/src/hooks/useChatStreaming.ts` (신규)
  - 기존 레이아웃 파일(`web/src/components/chat/ChatOrchestrator.tsx`) 정리
- **M3 – 서버 응답 모듈화 & 스키마**
- `server/routes/chat.ts`
- `server/services/chatResponder.ts` (신규)
- `server/services/responsesSchemas.ts` (정비 및 Zod 생성 결과 반영, 액션 JSON 제거)
- `packages/chat-schema` (신규 공유 타입 패키지)
- **M4 – 스트리밍 UX 개선**
  - `server/routes/chat.ts` (SSE 이벤트 구조 개선)
  - `web/src/services/api.ts` (`chatStream` 이벤트 처리)
  - `web/src/hooks/useChatStreaming.ts`
- **M5 – 테스트 & 모니터링**
  - `server/tests/chat/chat-route.test.ts` (신규 통합 테스트)
  - `web/src/hooks/__tests__/useChatMessages.test.ts`
  - 관측 관련: `server/services/workflowEvents.ts`, 대시보드 스크립트 등

## 5. 예상 리스크 및 대응
| 리스크 | 대응 |
| --- | --- |
| 기존 기능 회귀 | 단계별 feature flag 혹은 Canary 구성, QA 케이스 문서화 |
| 스토어 도입에 따른 메모리 증가 | 메시지 수에 제한(예: 최근 100개), 필요 시 pagination |
| Responses 스키마 재생성이 다른 엔드포인트에 영향 | 공통 스키마 패키지로 추출하여 기존 엔드포인트와 동시 적용 |

## 6. 완료 기준 (Definition of Done)
- 스트리밍/REST 모든 경로에서 400 Responses 에러가 재발하지 않는다.
- 하드 리프레시 후 메시지 중복이 발생하지 않는다.
- `/api/chat` 통합 테스트, `useChatMessages` 훅 테스트가 도입되어 CI에 포함된다.
- 문서(`docs/0.사용자인터페이스.md`)가 새 구조에 맞게 업데이트된다.
