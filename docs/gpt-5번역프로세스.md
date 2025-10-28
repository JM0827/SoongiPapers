# GPT-5 기반 번역 파이프라인 V2 전환 설계서

## 1. 배경 및 목표
- 파이프라인 V2는 현재 `gpt-4o`에 맞춰 구현/검증되어 있으며, Draft → Revise → Micro-Checks 흐름은 안정적이지만 원문 문장의 누락 사례가 보고됨.
- GPT-5 계열 모델(`gpt-5`, `gpt-5-mini`, `gpt-5-nano`)이 Responses API 및 구조화 출력, 도구 호출에서 더 강력한 기능을 제공하므로 번역 품질/속도/운영성을 동시에 개선하고자 함.
- 목표는 **GPT-5 전환 후에도 누락 없는 Draft 품질을 보장**하고, Responses API 규격에 맞춘 안정적인 호출/모니터링/재시도 체계를 구축하는 것.

## 2. GPT-5 마이그레이션 필수 체크리스트
1. **모델 ID 교체**: `gpt-4o*` → `gpt-5` 계열 정확한 문자열 사용 (`gpt-5`, `gpt-5-mini`, `gpt-5-nano`).
2. **Responses API 표준화**: 모든 Chat Completions 호출을 `openai.responses.create()` 기반으로 이관.
3. **새 파라미터 체계**: `temperature / top_p` 대신 `verbosity`, `reasoning.effort` 사용. (일부 환경에서 temperature 지정 시 에러 발생)
4. **max_output_tokens 관리**: Draft/Revise/Synthesis 등 장문 응답은 명시적으로 토큰 상한 설정.
5. **추론 강도 튜닝**: 파이프라인 스테이지별 effort/verbosity preset 정의 (Draft는 coverage 우선, Revise는 fluency 우선 등).
6. **구조화 출력 강화**: `response_format` JSON 스키마 사용 지속, 실패 시 즉시 재시도 로직 유지.
7. **도구 호출 확장성**: GPT-5의 free-form tool call 지원을 고려해 Micro-Checks/후처리 연계 용이하게 설계.
8. **에러/백오프 전략 업데이트**: GPT-5 특유의 파라미터 에러, 추론 비용 상승 시 단계별 effort/청크 조정 로직 반영.
9. **청크링 & 스트리밍 재설계**: 2~3k 토큰 기반 세그먼트 + 10~15% 오버랩, 스트리밍 수신 시 부분 완료 파싱.
10. **모델 선택 정책 정립**: 기본 `gpt-5`, 경량 검증은 `gpt-5-mini`, 대량 작업은 `gpt-5-nano`로 분기.

## 3. 영향 범위 분석
| 영역 | 현재 구현 | GPT-5 전환 시 영향 |
| --- | --- | --- |
| Draft 생성 (`server/agents/translation/translationDraftAgent.ts`) | `openai.chat.completions.create` + temperature/top_p | Responses API 전환, verbosity/reasoning/max tokens 도입, span coverage guard 강화, 후보 판단 로직 보강 |
| Draft 후보 심사 (`deliberateDraftCandidates`) | chat.completions + JSON schema | 동일하게 Responses API + effort=\"minimal\" preset, 실패 시 백오프 |
| Revise (`server/agents/translation/reviseAgent.ts`) | chat.completions + JSON schema | Responses API, effort/verbosity 치환, span_pairs 유지 |
| Synthesis (`server/agents/translation/translationSynthesisAgent.ts`) | chat.completions + JSON schema | Responses API, 길이 제한/summary 방지 검증 유지, 토큰 상한 확대 |
| Sequential Stage LLM (`server/services/translation/llm.ts`) | Responses API 사용 중이나 temperature/top_p 기반 | V2 통합 시 동일 preset 사용, stage config를 verbosity/reasoning으로 교체 |
| 큐/옵션 (`server/services/translationQueue.ts`) | draftConfig.temperature/topP | 새로운 설정 키(`verbosity`, `reasoningEffort`, `maxOutputTokens`)로 확장 |
| Mongo Draft 스키마 (`server/models/TranslationDraft.ts`) | temperature/top_p 필드 저장 | 새 필드(`verbosity`, `reasoning_effort`, `max_output_tokens`) 추가 및 마이그레이션 |
| 기록/로깅 (`recordTokenUsage`, `synthesis` 저장) | 모델/temperature/topP 기록 | GPT-5 파라미터 기록 및 대시보드 확장 |
| Micro-Checks Guard (`runMicroChecks`) | Draft/Revise 결과 기반 | Draft coverage 실패 시 차단 경로 추가, `gpt-5-mini` 검증 옵션 |
| ENV 설정 (`server/.env`) | gpt-4o 기본값, temperature 기반 | gpt-5 기반 default + verbosity/reasoning env 추가 |

## 4. 설계 상세
### 4.1 환경 및 설정 업데이트
- `.env` / `server/config` 전반을 업데이트해 GPT-5 기본값 반영:
  - `TRANSLATION_DRAFT_MODEL_V2`, `TRANSLATION_DRAFT_JUDGE_MODEL_V2`, `TRANSLATION_REVISE_MODEL_V2`, `TRANSLATION_SYNTHESIS_MODEL` → `gpt-5`.
  - 새 ENV 키: `TRANSLATION_DRAFT_VERBOSITY_V2`, `TRANSLATION_DRAFT_REASONING_EFFORT_V2`, `TRANSLATION_DRAFT_MAX_OUTPUT_TOKENS`, Revise/Synthesis 동일 패턴.
  - 경량 검증용: `TRANSLATION_DRAFT_VALIDATION_MODEL=gpt-5-mini`.
  - 세그멘테이션 길이 조정용: `SEGMENTATION_MAX_SEGMENT_LENGTH_V2` (기본 1,600자).

### 4.2 SDK 호출 레이어 (Responses API 통합)
- `OpenAI.chat.completions.create` 사용 부위를 모두 `openai.responses.create`로 교체.
- 입력 포맷: `input: [{ role: 'system', content: [...] }, { role: 'user', content: [...] }]`로 통일.
- `text.format`에 JSON Schema를 지정할 때는 **`additionalProperties: false` 및 `required` 배열을 모든 속성에 대해 명시**해야 한다. (원문 프로필 전환 시 해당 조건 누락으로 400 오류가 발생했으므로 공통 유틸로 관리한다.)
- `temperature/top_p` 제거 → Responses API 구조(`output_text`, `output_parsed`) 활용. `safeExtractOpenAIResponse` 확장 시 `verbosity`·`reasoning_effort`·`retry` 정보를 usage 메타에 포함한다.
- 스트리밍 도입 예정 구간(Draft)에서는 `.stream()` 인터페이스 도입 준비. 1차 릴리스는 비스트리밍으로 시작하되, parser와 청크처리를 사전 설계.

- **요청 파라미터**: `verbosity='medium'`, `reasoning.effort='medium'`, `max_output_tokens = chunk_avg * 1.2` (기본 2,200 / cap 6,400). 응답 `incomplete_details.reason === "max_output_tokens"` 감지 시 토큰 버짓을 점진적으로 확장하고, 동일 모델에 대한 추가 시도를 `verbosity='low'`, `effort='minimal'`로 자동 완화한다.
- **필수 스키마 확장**: `segments[].spanPairs`를 응답 스키마에 포함해 1:1 매핑을 강제. 누락 시 재시도.
- **Coverage Guard** *(TODO)*: Draft 완료 후 `gpt-5-mini` 기반 coverage 검증을 실행하고, 누락 문장이 확인되면 해당 세그먼트만 재시도하는 파이프라인을 보강한다. (추적: `docs/TODO-translation-gpt5.md`)
- **Chunking 전략**: `segmentationAgent` 결과를 1.6~3k 토큰 범위로 유지하고, 필요 시 10~15% 오버랩. 환경 변수 `SEGMENTATION_MAX_SEGMENT_LENGTH_V2`로 프로젝트별 최대 길이 조정.
- **관측로그** *(TODO)*: `coverageRatio = translatedSpans / originSpans` 등 Draft 품질 지표를 수집하고, 90% 미만 시 경고 및 자동 재시도 트리거를 구현한다.

### 4.4 Draft 후보 심사 (Deliberation)
- 모델: `gpt-5-mini`, `verbosity='low'`, `reasoning.effort='minimal'`, `max_output_tokens` 512.
- Responses API 전환 및 JSON 스키마 유지. 실패 시 백오프 전략: 1) effort 상승, 2) 후보 수 축소.
- 분석 결과(`analysis[]`) 저장 시 새로운 필드(`reasoning_effort`, `verbosity`) 함께 기록.
- `max_output_tokens` 부족이 감지되면 즉시 버짓을 증설하고 보수 파라미터(`verbosity='low'`, `effort='minimal'`)로 재시도한다.

### 4.5 Revise Stage
- 파라미터: `verbosity='medium'`, `reasoning.effort='low'`, `max_output_tokens`는 Draft 대비 +15%. 응답 중단 시 토큰 상한을 1.5~2배까지 확장하고 `verbosity/effort`를 한 단계 낮춘다.
- 스키마에 `span_pairs` 포함. Draft 누락이 존재할 경우 Revise 호출 차단 후 Draft 재시도.
- Responses API 전환, JSON 파싱 실패 시 재시도/로깅 경로 유지.

### 4.6 Synthesis Stage *(Deprecated in V2)*
- 기존 V1 파이프라인에서 사용한 통합 단계로, 현재 V2 구현에서는 Revise 결과를 최종본으로 사용한다.
- 향후 Synthesis 재도입이 필요하면 GPT-5 Responses API 스펙에 맞춰 별도 에이전트를 재설계한다. (추적: `docs/TODO-translation-gpt5.md`)

### 4.7 Sequential Stage LLM (`callStageLLM`)
- 이미 Responses API 사용 중이지만 temperature/top_p 기반 → `stageConfig`에 `verbosity`/`reasoningEffort`/`maxOutputTokens`를 주입하도록 변경.
- Stage별 preset:
  - Literal: `verbosity='low'`, `reasoning.effort='minimal'`
  - Style: `verbosity='medium'`, `reasoning.effort='low'`
  - Emotion: `verbosity='medium'`, `reasoning.effort='medium'`
  - QA: `verbosity='low'`, `reasoning.effort='low'`
- `StageCallOptions`/`StageCallResult` 타입 확장 및 기록 포맷 수정.

### 4.8 데이터 모델 및 지속성
- `TranslationDraftSchema`에 새 필드 추가: `verbosity`, `reasoning_effort`, `max_output_tokens`.
- 기존 `temperature/top_p`는 하위 호환을 위해 유지하되, gpt-5 경로에서는 null 저장.
- `completeDraft`, `TranslationDraftDocument` 타입 업데이트, Mongo 저장 로직/TypeScript 타입 동기화.
- Revise/Synthesis 결과 저장 시에도 새 파라미터 기록.

### 4.9 구성/옵션 전파
- `TranslationDraftJobData` / `TranslationSynthesisJobData`에 새로운 옵션 필드 추가 (`draftConfig.verbosity`, `draftConfig.reasoningEffort`, `draftConfig.maxOutputTokens`).
- CLI/관리자 UI에서 환경별 preset을 관리할 수 있도록 설정 주입 경로 문서화.

### 4.10 관측 및 테스트
- Draft/Revise/Synthesis 결과에 `analysis_meta`(model, verbosity, reasoning_effort, max_output_tokens 요청/실제, chunk_count, retry_count, truncated) 메타데이터를 저장하고, 동일 값을 토큰 사용 로그/모니터링 파이프라인에서 소비할 수 있도록 serialize.
- Observability 대시보드(메트릭 수집) 업데이트: Draft Coverage %, 재시도 횟수, effort/verbosity 조정 로그, 토큰 버짓 증설 이벤트 추적.
- 테스트 계획:
  - Vitest 단위 테스트: Draft/Revise/Synthesis 호출 모킹 → Responses API JSON 파싱 검증.
  - 통합 테스트: 샘플 Origin 3종(단문/중문/장문)에 대해 Draft coverage ≥99% 확인.
  - 회귀 테스트: gpt-4o vs gpt-5 결과 비교(토큰 비용, latency, coverage).

## 5. 리스크 및 대응 전략
| 리스크 | 대응 |
| --- | --- |
| Responses API 호환 이슈 | Beta 환경에서 Draft/Revise/Synthesis 호출 모킹 → JSON 파싱 실패 케이스 캡처 |
| 토큰 초과/응답 절단 | `max_output_tokens` 자동 증설 + verbosity/effort 하향, 필요 시 chunk 재분할 및 mini 모델 fallback |
| 비용 상승 | `reasoning.effort` 기본값을 `medium/low`로 시작, Observability로 비용 모니터링, 필요 시 `gpt-5-mini` fallback |
| Schema 불일치 | 스키마 검증 실패 → 자동 재시도 후 failover. `coerceSegments` 로직 Responses API 구조에 맞춰 업데이트 |
| 데이터 마이그레이션 | Mongo 컬렉션 필드 추가 시 마이그레이션 스크립트 제공, 구버전 필드는 유지 |
| 운영 중단 | Feature flag 기반 라우팅 유지, gpt-4o 경로 롤백 버튼 제공 |

## 6. 구현 Milestone
1. **M0 – 준비 (0.5주)**
   - 환경 변수/구성 정리, Responses SDK 버전 확인.
   - Translation Draft/Revise/Synthesis 모듈 단위 테스트 Harness 준비.
2. **M1 – Draft 모듈 전환 (1주)**
   - Draft 요청 Responses API화, span coverage guard 도입.
   - Draft 후보 심사(`gpt-5-mini`) 전환 및 백오프 로직 구현.
   - Draft 엔티티/로그 스키마 업데이트.
3. **M2 – Revise & Synthesis 전환 (1주)**
   - Revise Responses API, effort/verbosity 설정.
   - Synthesis Responses API + 토큰 상한 + summary 방지 검증.
   - Micro-Checks 입력 데이터 (`span_pairs`) 유효성 점검.
4. **M3 – 큐/설정/데이터 계층 (0.5주)**
   - 큐 payload, config, env, Mongo schema 등 전파.
   - 마이그레이션 스크립트/백필 작업 (기존 문서에 null 필드 추가).
5. **M4 – Observability & Backoff (0.5주)**
   - `recordTokenUsage` 확장, coverage 메트릭 수집.
   - Logs/alert 룰 갱신 (응답 누락, effort 재시도 등).
6. **M5 – QA & 롤아웃 (1주)**
   - 스테이징에서 gpt-4o vs gpt-5 A/B 비교.
   - 파일럿 프로젝트 대상 Feature flag ON 후 모니터링.
   - KPI 충족 시 글로벌 enable 및 gpt-4o 경로 sunset 계획 수립.

## 7. 추가 확인 사항
- Responses API로 전환하면서 SDK 버전 업그레이드 필요 시, 다른 서비스(`profileAgent`, `proofreading`, `chat` 라우터 등)의 호환성 체크.
- Draft chunking 변경이 Downstream(Proof UI, Micro-Checks) 데이터 흐름에 미치는 영향 검토.
- Free-form tool call 활용 여부는 후속 과제로 남기되, Agent 호출 인터페이스에 hooks를 남겨 확장이 용이하도록 설계.
- **TODO 요약**
  - Draft coverage guard 및 세그먼트 단위 재시도 워크플로우 보강 (`docs/TODO-translation-gpt5.md`).
  - Revise 단계 truncation 백오프 개선 및 세그먼트 재시도 적용.
  - Observability 대시보드/알림 구성 및 coverageRatio, retryCount 등 메트릭 표준화.
  - Synthesis 단계 재도입 여부 결정 및 문서/코드 갱신.

---
**담당**
- Owner: Translation Platform Team
- 리뷰어: NLP 품질 파트, Infra 파트
- 최초 작성: 2025-01-14
- 수정 기록: 전환 진행 중 업데이트 예정
