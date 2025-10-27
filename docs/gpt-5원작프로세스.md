# GPT-5 기반 원작 처리 파이프라인 전환 설계서

## 1. 배경 및 목표
- 현재 원작 처리 파이프라인(파일 업로드 → 텍스트 정제 → 원문 요약/번역 노트 생성)은 `gpt-4o`/`gpt-4o-mini` 기반 `chat.completions` 호출에 맞춰 구현되어 있음.
- GPT-5 계열이 Responses API 중심으로 구조화 출력, 긴 컨텍스트, 도구 호출을 강화하고 있어, 원문 요약 품질 및 번역 노트 정확도를 향상시키기 위해 GPT-5로 전환 필요.
- 목표는 **원문 분석 단계에서 GPT-5를 안정적으로 사용**하면서, Responses API 규격과 GPT-5 권고사항(verbosity, reasoning.effort, max_output_tokens, 청크 전략 등)을 준수하고, 기존 번역 노트 스키마/데이터 저장 흐름과의 호환성을 유지하는 것.

## 2. GPT-5 마이그레이션 체크리스트
1. **모델 ID 교체**: `PROFILE_AGENT_MODEL` 등 gpt-4o 계열 → `gpt-5` 계열 정확한 ID 사용.
2. **Responses API 도입**: `chat.completions` 호출을 `openai.responses.create()`로 전환.
3. **새 파라미터 적용**: `temperature/top_p` 제거, `verbosity`, `reasoning.effort`, `max_output_tokens` 사용.
4. **출력 스키마 보강**: `response_format=json_schema` 유지/강화, 파싱 오류 시 재시도.
5. **청크링/스트리밍 계획**: 긴 원문(>8k chars) 처리 시 2~3k 토큰 단위 청크 + 스트리밍 수신 고려.
6. **에러/백오프 전략**: GPT-5 특유 파라미터 에러/비용 상승에 대비한 effort 조정, 청크 재시도 로직 도입.
7. **모델 정책**: 기본 `gpt-5`, 속도/비용 민감 시 `gpt-5-mini`, 배치 분석 시 `gpt-5-nano` 활용 정책 정립.
8. **환경 변수 확장**: verbosity, reasoning_effort, max tokens를 ENV/설정으로 관리.
9. **관측 지표 업데이트**: 토큰 사용량 + effort/verbosity + 청크 coverage 도입, KPI 추적.
10. **보안/호환성**: 새로운 SDK 버전이 다른 서비스(번역, 교정)와 충돌하지 않는지 검증.

## 3. 영향 범위 분석
| 영역 | 현재 구현 | GPT-5 전환 시 영향 |
| --- | --- | --- |
| 프로파일 분석 에이전트 (`server/agents/profile/profileAgent.ts`) | `openai.chat.completions.create`, `temperature=0.5`, JSON object | Responses API 전환, verbosity/reasoning/max tokens 도입, JSON 스키마 강화 |
| 프로파일 워커 (`server/index.ts` 3000~3120) | `analyzeDocumentProfile` 호출 결과를 DB 저장 | 출력 필드(usage, 모델명) 포맷 수정, effort/verbosity/coverage 로깅 |
| ENV/설정 (`server/.env`, `PROFILE_AGENT_MODEL`) | gpt-4o 기본값, 온도 기반 | `PROFILE_AGENT_MODEL=gpt-5`, 추가 ENV (`PROFILE_AGENT_VERBOSITY`, `PROFILE_AGENT_REASONING_EFFORT`, `PROFILE_AGENT_MAX_OUTPUT_TOKENS`) |
| 텍스트 트렁케이션 (`MAX_CONTEXT_CHARS=8000`) | 단일 8k 문자 제한, 초과 시 잘라냄 | GPT-5 토큰 예산 기반 청크링 설계(2~3k 토큰), 스트리밍 파서 준비 |
| TranslationNotes 파싱/검증 | JSON parse 후 TypeScript 정규화 | 스키마 엄격화, 누락 필드 자동 보정 시 재시도 가능성 |
| Observability (`recordTokenUsage`, profile metrics) | 모델/토큰만 로깅 | effort/verbosity/청크 정보 추가, 요약 길이/coverage 측정 |
| Queue/작업 관리 (`enqueueProfileAnalysisJob`) | 입력 변경 없음 | 작업 payload에 새 옵션(verbosity, mini 모델 fallback) 추가 고려 |

## 4. 설계 상세
### 4.1 환경 및 구성 업데이트
- `.env` 및 구성 모듈 업데이트:
  - `PROFILE_AGENT_MODEL=gpt-5`
  - 새 키: `PROFILE_AGENT_VERBOSITY=medium`, `PROFILE_AGENT_REASONING_EFFORT=medium`, `PROFILE_AGENT_MAX_OUTPUT_TOKENS=1200` (기본 값 예시).
  - 경량 분석용: `PROFILE_AGENT_VALIDATION_MODEL=gpt-5-mini` (fallback 용).
- Feature flag 없이 전체 전환하되, 필요 시 `PROFILE_AGENT_USE_GPT5=true`와 같은 토글 도입 가능.

### 4.2 Responses API 적용
- `OpenAI` 인스턴스는 동일, 호출부를 `openai.responses.create`로 변경.
- 입력 구조 예시:
  ```ts
  const response = await openai.responses.create({
    model,
    max_output_tokens,
    response_format: {
      type: 'json_schema',
      json_schema: profileResponseSchema,
    },
    input: [
      { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
      { role: 'user', content: [{ type: 'input_text', text: userPrompt }] },
    ],
    reasoning: { effort },
    verbosity,
  });
  ```
- `safeExtractOpenAIResponse` 재사용 가능하나, `output_parsed`/`output_text` 구조에 맞춰 JSON 추출 로직 보강.

### 4.3 출력 스키마 강화
- 기존 JSON object 강제에서 **JSON Schema**로 전환:
  ```json
  {
    "type": "object",
    "required": ["summary", "intention", "readerPoints", "translationNotes"],
    "properties": {
      "summary": { "type": "string", "maxLength": 800 },
      "intention": { "type": "string", "maxLength": 300 },
      "readerPoints": { "type": "array", "items": { "type": "string" }, "minItems": 2, "maxItems": 4 },
      "translationNotes": { "type": "object", ... }
    }
  }
  ```
- 응답 누락 시 재시도: 1차 `verbosity='medium'`, 2차 `verbosity='high'` + `reasoning.effort='high'`, 3차 `gpt-5-mini` fallback.

### 4.4 청크링 & 스트리밍
- `MAX_CONTEXT_CHARS` 제거/완화 → 토큰 기반 계산(`estimateTokens`).
- 긴 원문은 2~3k 토큰 청크 + 10% 오버랩으로 분할, 각 청크마다 Responses 호출 후 결과 통합.
- 스트리밍 (`responses.stream`) 도입을 고려: Partial 결과 수신 시 JSON 파서 버퍼에 저장, 완료 이벤트에서 검증.
- 청크별 `sourceHash` 계산 시 원본 전체 해시 유지 + 세그먼트 해시 추가.

### 4.5 번역 노트 품질 강화
- GPT-5의 구조화 출력을 활용해 `translationNotes` 내부 각 리스트에 대해 세부 스키마 정의(필수/옵션 필드, max 길이).
- 누락 검출 로직 추가: 예) 인물/고유명사 빈 배열 → 경고 플래그, 필요 시 effort 상향 재시도.
- `parseTranslationNotes` 보완: GPT-5가 null/빈 문자열 반환 시 기본값 보간.

### 4.6 Observability 및 리트라이 전략
- `recordTokenUsage` 확장: model, verbosity, reasoning_effort, max_output_tokens, chunkCount, retryCount, coveragePercent 기록.
- 에러 패턴별 백오프 전략:
  - `Unsupported parameter` → 파라미터 매핑 점검, fallback to legacy only if 긴급.
  - `max_output_tokens` incomplete → max 상향 또는 청크 분할.
  - 비용/지연 상승 → effort 단계적 하향 + mini 모델 fallback.

### 4.7 데이터 저장/호환성
- `DocumentProfile` 저장 구조 변경 없음. 단, 분석 결과에 새 메타 정보(`analysisMeta`) 추가 (model, effort, verbosity, chunk summary 등) → JSON/BSON 필드 확장.
- API 응답 시 backward compatibility 유지 (기존 UI가 추가 메타를 무시하도록).

### 4.8 테스트 계획
- 유닛 테스트: `profileAgent`를 Vitest로 모킹하여 Responses API 출력 파싱 검증.
- 통합 테스트: 샘플 원문 3종(단편/중편/장편) → 요약 길이, 번역 노트 커버리지 확인.
- 회귀 비교: gpt-4o vs gpt-5 결과 (요약 길이, 번역 노트 항목 수, 토큰 비용) A/B.

## 5. 리스크 및 대응
| 리스크 | 대응 |
| --- | --- |
| Responses API 파싱 실패 | JSON Schema + 재시도 로직, `safeExtractOpenAIResponse` 개선 |
| 긴 원문 처리 중 비용 급등 | Chunk+stream + effort 조정, `gpt-5-mini` fallback |
| 번역 노트 스키마 불일치 | 엄격 검증 + 자동 재시도, 실패 시 사용자에게 경고 |
| ENV 설정 누락 | 배포 체크리스트에 새로운 ENV 포함, 기본값 제공 |
| SDK 버전 충돌 | 다른 모듈에서 사용하는 OpenAI SDK 호환성 테스트 |
| 운영 중단 위험 | 전환 초기 feature flag 혹은 fallback 경로(gpt-4o) 유지 |

## 6. 구현 Milestone
1. **M0 – 준비 (0.5주)**: SDK 버전 업그레이드, ENV 정의, 테스트 하네스 준비.
2. **M1 – Responses API 전환 (0.5주)**: `profileAgent` 호출부 리팩터, JSON Schema 도입, 파서/재시도 로직 구현.
3. **M2 – 청크링/스트리밍 (1주)**: 토큰 기반 분할, 스트리밍 파서(옵션) 구현, coverage 로깅.
4. **M3 – 번역 노트 품질 강화 (0.5주)**: 스키마 세분화, 누락 가드, mini 모델 fallback 로직.
5. **M4 – Observability & 백오프 (0.5주)**: `recordTokenUsage` 확장, 로그/알림 규칙 업데이트.
6. **M5 – QA & 롤아웃 (1주)**: 스테이징 검증, 파일럿 프로젝트 적용, KPI 비교 후 전체 전환.

## 7. 추가 확인 사항
- Responses API 전환이 번역/교정 파이프라인에서도 필요하므로 SDK 변경 영향 범위 점검.
- 청크 기반 처리 시 기존 `sourcePreview`/`sourceHash` 저장 방식이 변하지 않도록 확인.
- 추후 Cover Generator 등 다른 워크플로에 번역 노트가 전달될 때 GPT-5가 생성한 추가 필드가 문제 없도록 소비처 검증.
- Free-form tool call 활용(예: 고유명사 표준화 도구)은 후속 과제로 남기되, 인터페이스 확장 여지 확보.

---
**담당**
- Owner: Content Analysis Team
- 리뷰어: NLP 품질 파트, Infra 파트
- 최초 작성: 2025-01-14
- 수정 기록: 전환 진행 상황에 따라 업데이트 예정
