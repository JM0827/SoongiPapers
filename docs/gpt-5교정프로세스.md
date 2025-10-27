# GPT-5 기반 교정(Proofer) 파이프라인 전환 설계서

## 1. 배경 및 목표
- 교정 파이프라인은 현재 `gpt-4o-mini` 중심으로 `chat.completions` API를 호출하며 Quick/Deep 서브피처를 JSON Spec(`server/agents/proofreading/proofreading.spec.json`)으로 관리.
- GPT-5 Responses API는 구조화 출력, 토큰 제어, reasoning 파라미터를 강화하므로, 교정 단계의 검출 정확도/근거 품질/안정성을 높이고 Guard 연동을 개선하기 위해 GPT-5로 전환한다.
- 목표는 **Quick/Deep 교정 전 과정을 GPT-5 기반으로 재구성**해 JSON 스키마 준수, 자동 재시도, 토큰 버짓 확대, 메타 로깅을 표준화하는 것.

## 2. GPT-5 마이그레이션 체크리스트
1. **모델 ID 교체**: Spec/ENV에서 `gpt-4o(-mini)` → `gpt-5`, `gpt-5-mini`, `gpt-5-nano`.
2. **Responses API 전환**: `runGenericWorker` 등 모든 Chat Completions 호출을 `openai.responses.create()`로 교체.
3. **새 파라미터 체계**: `temperature/top_p` 제거 → `text.verbosity`, `reasoning.effort`, `max_output_tokens` 적용.
4. **JSON Schema 엄격화**: 각 subfeature 응답에 대해 `additionalProperties: false`와 `required` 목록을 모든 속성에 대해 명시. (번역/원문 파이프라인 전환 시 schema 누락으로 400 오류가 발생했음.)
5. **토큰 버짓 관리**: `max_output_tokens`를 기본값으로 설정하고 `incomplete_details.reason === "max_output_tokens"` 발생 시 2배까지 자동 증설.
6. **재시도 전략**: 첫 실패→verbosity `medium`→`low`, effort `minimal`→`low`, 이후 mini 모델 fallback.
7. **결과 메타 기록**: Responses 메타(verbosity, effort, max tokens 요청/실제, retry, truncated, fallback 사용)를 저장해 observability 일관성 확보.
8. **Spec/ENV 관리**: `PROOFREADING_***` ENV에 새 파라미터 추가, Spec JSON 로더에서 필수 필드 검증.
9. **Guard 연동 강화**: GPT-5 friendly payload(`flagged_segments` 등) 유지, free-form tool call 대비 Hook 준비.
10. **청크 & 스트리밍 최적화**: Quick/Deep 청크 크기를 GPT-5 latency에 맞게 조정하고, Responses 스트리밍 도입 시 parser 준비.

## 3. 영향 범위 분석
| 영역 | 현재 구현 | GPT-5 전환 영향 |
| --- | --- | --- |
| Generic Worker (`server/agents/proofreading/genericWorker.ts`) | `chat.completions`, `temperature`, JSON.parse | Responses API, verbosity/reasoning, JSON Schema 검증, 자동 재시도/버짓 증설 |
| Proofreading Spec (`server/agents/proofreading/proofreading.spec.json`) | 모델/온도 중심 | 모델=GPT-5 계열, 새 필드(`verbosity`, `reasoningEffort`, `maxOutputTokens`) 추가, temperature 무효화 |
| Config & ENV (`PROOFREADING_MODEL`, `MAX_WORKERS`) | `gpt-4o-mini` 기본, 온도 값 | `gpt-5` 기본, Quick/Deep용 별도 모델/verbosity/effort/max tokens ENV |
| Guard 연동 (`genericWorker`, `buildGuardPayload`) | 기존 JSON payload | Responses schema와 호환되도록 정규화, guard 결과 메타 기록 |
| Runner (`proofreadingAgent.ts`) | p-limit 병렬, 온도 기반 옵션 | 새 옵션(verbosity/effort/max tokens) 주입, 재시도 결과 메타 반영 |
| Observability/logging | 모델/온도/토큰만 기록 | `meta`에 verbosity, effort, max tokens, retry, truncated 기록; Usage 로그 확장 |
| UI/Downstream | 결과 JSON 소비, 온도 노출 | 스키마 변동 없음. 필요 시 새 메타(verbosity/effort)를 optional 표기 |

## 4. 설계 상세
### 4.1 환경 및 Spec 업데이트
- `.env`
  - `PROOFREADING_MODEL=gpt-5`
  - `PROOFREADING_QUICK_MODEL=gpt-5-mini`, `PROOFREADING_DEEP_MODEL=gpt-5`
  - `PROOFREADING_QUICK_VERBOSITY=low`, `PROOFREADING_QUICK_REASONING_EFFORT=minimal`, `PROOFREADING_QUICK_MAX_OUTPUT_TOKENS=700`
  - Deep/추가 tiers 동일 패턴(verbosity/effort/MAX)
- Spec JSON (`proofreading.spec.json`)
  - 각 subfeature에 `verbosity`, `reasoningEffort`, `maxOutputTokens` 필드 추가
  - `temperature`는 계속 둬도 Responses 경로에서는 무시하거나 null 처리
  - JSON Schema 사용 시 모든 필드를 required에 포함하고 `additionalProperties: false`

### 4.2 Responses API 적용
- `runGenericWorker`
  - `client.responses.create({ model, max_output_tokens, text: { format: …, verbosity }, reasoning: { effort }, input: [...] })`
  - JSON Schema는 공통 유틸(번역/원문 단계와 동일)에 정의하고, lint/테스트로 `additionalProperties:false` + 모든 필드 `required` 누락을 미리 검출한다. Responses 요청 builder도 공통 helper로 묶어 반복 실수를 줄인다.
  - 응답 파싱: `safeExtractOpenAIResponse` 재사용, `parsed_json` 없으면 `text` JSON.parse 하되 실패 시 버짓 증설 후 재시도
- 스트리밍은 향후 옵션으로 남기되, chunk parser 준비

### 4.3 서브피처 파라미터
- Quick 기본: `model=gpt-5-mini`, `verbosity='low'`, `effort='minimal'`, `max_output_tokens=700`
- Deep 기본: `model=gpt-5`, `verbosity='medium'`, `effort='medium'`, `max_output_tokens=900`
- Spec loader가 ENV/Spec 값을 읽어 `GenericWorkerParams`에 전달, Responses 호출 전 검증

### 4.4 Guard/Context
- Guard payload 구조 유지 (`flagged_segments[]`), GPT-5 이해를 돕기 위해 요약 문구 추가
- Guard 실패/absence에 따라 effort/verbosity 동적으로 조정 가능하도록 hooks 준비

### 4.5 청크/병렬 처리
- Quick 청크: 4~6 문장 → GPT-5 latency 고려해 3~4 문장으로 축소 검토
- Deep 청크: 2~3 문장 유지
- `MAX_WORKERS`와 Spec `runtime.maxWorkers` 동기화

### 4.6 Observability & 백오프
- `runGenericWorker` 결과에 `meta` 포함: model, verbosity, reasoningEffort, maxOutputTokens(요청/실제), retryCount, truncated, fallbackModelUsed
- `proofreadingAgent`가 저장/로그 시 meta를 Mongo/Usage 로그에 기록
- 재시도 정책: 1차 실패 시 verbosity `medium`→`low`, effort `minimal`→`low`; 2차 실패 시 mini 모델 fallback
- `max_output_tokens` 부족 감지 시 버짓 자동 증설 (최대 cap ENV 정의) 후, 동일 모델을 보수 파라미터(verbosity/effort 하향)로 재시도한다. Responses 메타가 저장되는지 짧은 스모크 테스트로 확인한다.

### 4.7 데이터/호환성
- 결과 구조(items[])는 기존과 동일, meta는 optional 필드로 추가 (UI 영향 없음)
- GPT-4 fallback 경로 유지(Feature flag/ENV)로 롤백 용이

## 5. 리스크 및 대응
| 리스크 | 대응 |
| --- | --- |
| JSON Schema 불일치 | 스키마 lint/test 추가, `additionalProperties:false` + `required` 전체 명시, 실패 로그에 raw 미리보기 저장 |
| 토큰 초과 | 버짓 자동 증설 + verbosity/effort 낮춤 후 재시도, 필요 시 청크 축소 |
| 비용 상승 | Quick 기본 모델 `gpt-5-mini`, 필요 시 mini/nano fallback |
| SDK 호환성 | 번역/원문 파이프라인과 동일 SDK 버전 사용, 공통 util 공유 |
| Guard payload 호환 | JSON 구조 변화 시 단위 테스트 강화, Guard 없는 청크는 보수 파라미터로 실행 |
| 운영 중단 | Feature flag/ENV 스위치로 GPT-4 경로 유지, 초기 롤아웃은 파일럿 프로젝트에 한정 |

## 6. 구현 Milestone
1. **M0 – 준비**: SDK/ENV 업데이트, 공통 schema util/lint, 테스트 harness 준비
2. **M1 – Responses API 리팩터**: `runGenericWorker` 전환, meta 기록, 재시도 로직 구현
3. **M2 – Spec/Config**: JSON Spec 확장, loader 검증, ENV 반영
4. **M3 – Observability**: Usage 로그, meta 저장, alert 조정
5. **M4 – QA/Pilot**: GPT-4 vs GPT-5 A/B, KPI(이슈 검출률, false-positive) 비교
6. **M5 – 롤아웃**: 파일럿 → 전체 확대, GPT-4 경로 sunset 계획 수립

## 7. Lessons Learned 적용 사항
- JSON Schema는 `additionalProperties:false` + 모든 필드를 `required`에 명시 (Draft/Revise 단계에서 반복된 400 오류 방지)
- `max_output_tokens` 초과 시 토큰 버짓 1.5~2배 자동 증설 후 보수 파라미터로 재시도 (Draft/Revise/Synthesis 경험 반영)
- `safeExtractOpenAIResponse` 활용 시 `parsed_json` 없을 때 raw 텍스트 JSON.parse, 실패 시 에러와 preview 로그 후 재시도
- meta(verbosity/effort/token budget/retry/truncated/fallback) 저장 후 Observability에서 활용 (원문/번역 전환에서 이미 사용)
- 공통 util/스키마 정의를 공유해 각 단계가 동일한 패턴을 사용하도록 유지 (추후 유지보수 비용 감소)

### 추가 권고 (번역/원문 전환 경험 기반)
- Responses API 요청을 구성할 때는 공통 builder를 사용해 schema·input·재시도 로직을 일관화한다.
- `max_output_tokens` 부족 시 cap까지 자동 증설 후에도 truncated가 남으면 해당 subfeature를 실패로 처리하고 운영자에게 chunk 축소를 안내한다.
- Quick/Deep tier별 `max_output_tokens` 값은 긴 문서에서도 충분히 남도록 보수적으로 잡고, fallback mini 모델을 명시해둔다.
- 새/변경된 schema는 린트 스크립트 또는 CI 테스트로 `additionalProperties:false`와 `required` 조건을 검증한다.
- Observability에 “토큰 버짓 증설”, “fallback 모델 사용”, “truncated 감지” 이벤트를 추가해 QA가 바로 확인할 수 있도록 한다.

---
**담당**
- Owner: Proofreading QA Team
- 리뷰어: NLP 품질 파트, Infra 파트
- 최초 작성: 2025-01-14
- 최신 수정: 2025-XX-XX GPT-5 전환 Lessons Learned 반영
