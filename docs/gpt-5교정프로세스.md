# GPT-5 교정(Proofreading) 프로세스 설계 및 고도화 제안

## 1. 비전과 목표
- 앱의 궁극적 목표는 **휴먼 번역을 능가하는 최고 수준의 번역 품질**을 실현하는 것이다.
- 교정 파이프라인은 번역 Draft/Revise 단계를 통과한 결과물에 대한 마지막 자동 점검 계층으로, 오류 발견·수정 제안을 통해 번역 품질을 극대화한다.
- 현재 구현은 `gpt-4o-mini` 기반 `chat.completions` 호출과 규칙 기반 Guard를 결합한 구조다. 본 문서는 **GPT-5 Responses API 전환 + 고급 알고리즘 도입**을 통해 교정 파이프라인이 비전 달성에 기여할 설계 방향을 정리한다.

## 2. 시스템 아키텍처 개요 (TDM / BDM 관점)
| 역할 | 설명 | 코드 기준 |
| --- | --- | --- |
| TDM (Proofreading Task/Decision Manager) | 교정 요청 큐 관리, 세그먼트 정렬, LLM 호출 orchestration, 진행 이벤트 스트리밍 | `server/routes/proofreading.ts`, `server/agents/proofreading/proofreadingAgent.ts` |
| BDM (Proofreading Baseline/Data Manager) | Guard/히스토리/리포트 저장, Proofread Run 이력 관리, UI/리포트 소비 데이터 유지 | `server/db/pg`, `server/db/mongo`, `docs/4.품질검토프로세스.md` 연계 |

### 2.1 TDM 흐름
1. `POST /api/proofread` 가 호출되면 프로젝트/번역 파일 정보를 바탕으로 교정 잡을 시작 (`server/routes/proofreading.ts:18-118`).
2. `runProofreading`이 Mongo `translation_files`에서 최종 번역 텍스트를 로드하고, 중복 작업 여부를 체크한다 (`server/agents/proofreading/proofreadingAgent.ts:300-346`).
3. Guard 데이터(`translation_drafts` stage='qa')와 Project Memory/DocumentProfile의 번역 노트를 로드해 교정 컨텍스트를 구성한다 (`loadSegmentGuards`, `loadProjectMemoryForProofread`).
4. 원문/번역을 문장 단위로 분할 후 Spec 기반 정렬(`alignBySpecAsync`)을 수행한다 (`server/agents/proofreading/utils.ts`).
5. Spec(`proofreading.spec.json`)에 정의된 Quick/Deep subfeature 목록을 순회하며 `runGenericWorker`로 LLM 평가를 수행한다.
6. 진행 상황은 `ProofreadingProgressEvent`로 스트리밍되어 UI가 실시간 업데이트 가능하다 (duplicate, stage, tier_complete, complete 등).

### 2.2 BDM 흐름
1. 교정 요청 및 상태는 Postgres `proofreading_history` / `proofread_runs` 테이블에 기록 (`server/db/pg/*`).
2. LLM 결과(Quick/Deep tier 보고서, 최종 보고서)는 Mongo `proofreading_files` 컬렉션에 저장 (`saveProofreadingDoc`).
3. Guard 매칭 및 노트는 보고서에 포함되어 Proofread Editor UI와 품질 리포트에서 참조한다.
4. 최종 보고서는 Quality 평가 및 번역 프로세스 후속 단계와 연결된다.

## 3. 데이터 흐름 및 정렬 과정
1. **입력 데이터**: `origin_content`, `translated_content` (Mongo `translation_files`), Guard 정보 (`translation_drafts` stage='qa'), Project Memory/DocumentProfile의 번역 노트·용어집(향후) (`document_profiles`, `project_memory`).
2. **문장 정렬**: Spec 설정에 따라 한국어/영어 문장을 분할(`splitSentencesByLang`) → Greedy/embedding 기반 정렬(`alignBySpecAsync`).
3. **청크 생성**: `chunkAlignedPairs`가 Quick/Deep tier에 맞춰 문장 페어를 n개씩 묶는다 (기본 quick=4, deep=2).
4. **Guard/메모리 적용**: 청크별로 `collectGuardSegmentsForTarget`이 관련 QA Guard 결과를 찾아 guardContext로 전달하며, Project Memory의 `strictFacts`·`term_map` 등을 병합해 `memoryContext`로 전달한다. Quick tier는 Guard 문제가 없고 메모리 위반 가능성이 낮으면 스킵하여 비용 절감.

## 4. LLM 호출 구조 (현행 → GPT-5 전환 계획)
### 4.1 현행 구조 (chat.completions)
- 함수: `runGenericWorker`
- 입력: 시스템 프롬프트 + JSON 문자열 형태 사용자 프롬프트 (`task`, `constraints`, `source_text`, `target_text`, guardContext, memoryContext).
- 출력: `{ items: [...] }` 구조를 파싱해 Proofread 이슈 항목 생성.
- 제약: `temperature`, `response_format=json_object` 기반. JSON Schema 검증, 토큰 버짓 자동 확장, verbosity/effort 조절이 미흡.

### 4.2 GPT-5 Responses API 전환 설계
- 공통 호출 유틸을 도입해 아래 기능을 표준화한다:
  - `openai.responses.create({ model, max_output_tokens, text: { format: { type: 'json_schema', schema, strict: true }, verbosity }, reasoning: { effort }, input: [...] })`
  - JSON Schema는 subfeature별 `{ items:[...] }` 구조에 `additionalProperties:false`와 모든 필드 `required`를 명시.
  - 사용자 메시지에는 Guard 컨텍스트와 함께 Project Memory에서 추출한 `memoryContext`(번역 노트, 캐릭터/설정, glossary)를 주입해 각 서브피처가 설정 변경을 탐지하도록 한다.
  - 재시도 시 토큰 버짓 1.5~2배 증가, verbosity/effort 단계별 하향, mini 모델 fallback.
  - `safeExtractOpenAIResponse` 활용으로 `parsed_json`/`output_text` 파싱 일원화.
  - 응답 메타(모델, verbosity, effort, max tokens, retryCount, truncated, fallbackModelUsed)를 결과에 포함.

#### 권장 기본 파라미터
| Tier | 모델 | verbosity | reasoning.effort | max_output_tokens |
| --- | --- | --- | --- | --- |
| Quick | `gpt-5-mini` | `low` | `minimal` | 800 |
| Deep | `gpt-5` | `medium` | `medium` | 1,200 |

## 5. 교정 알고리즘 및 향상 방안
### 5.1 현행 주요 알고리즘 요소
- Guard + LLM 하이브리드: 기존 QA Guard 결과를 참조해 LLM이 집중할 문장을 선별.
- Spec 기반 서브피처: Quick/Deep 단계로 나누어 규칙/문체/문화적 오류 등 다양한 측면을 평가.
- 리포트 버킷팅: `makeBucketsFromSpec` → `filterBuckets` → subfeature별 이슈/추천/근거를 정리.

### 5.2 GPT-5 도입 시 고도화 아이디어
1. **증거 기반 코멘트 요구**: 교정 이슈에 원문/번역 인용 근거와 참조 소스를 필수로 요구하고(JSON schema `items[].evidence`·`items[].source` 추가), 누락 시 해당 이슈를 무효 처리한다. Quick tier는 인접 1~2문장, Deep tier는 확장 문맥을 자동 첨부한다.
2. **Dual-Pass 정렬**: embeddings DP 정렬 이후 GPT-5 alignment 검증을 수행해 불일치 시 재정렬하도록 한다. 정렬 결과와 신뢰도는 메트릭으로 기록한다.
3. **LLM Self-Consistency**: Deep tier에서 동일 청크를 k회 평가하고 다수결/Confidence weighting으로 노이즈를 제거한다. 응답 메타에 호출 횟수, 합의 여부를 남긴다.
4. **Guard ↔ LLM 피드백 루프**: Guard와 LLM 판단이 어긋나면 이슈에 사용자 친화적 상태(예: “번역 QA에서도 확인”, “교정 AI만 발견”, “QA 자동 점검만 발견”)를 표기하고, Proofread 요약/대시보드에서 반복 패턴을 강조한다. Guard 자동 갱신은 후속 과제로 남기되, UI/보고서 내에서 즉시 조치할 수 있게 한다.
5. **용어/스타일 메모리 통합**: Project Memory의 `term_map`, `character_sheet`, `translationNotes`를 Quick/Deep 프롬프트에 `memoryContext`로 주입해 terminology drift·설정 변경을 예방한다. 향후 glossary 추가 시 동일 경로를 사용한다.
6. **Hallucination 검출**: 번역에 없는 문장 추가 여부를 품질 검토 청크 결과와 교차 검증하고, 길이/사건 순서/인물 속성 일관성 검사를 서브피처로 추가한다.
7. **자동 수정 후보 (Rewrite Agent)**: 고신뢰 이슈의 `after` 제안을 Translation Draft Store에 패치 후보로 저장하고, 승인 혹은 `autoPatchEnabled` 프로젝트에서 Revise 이후 재적용한다.
8. **문맥 단위 강화**: LLM 호출 시 인접 청크, 이전 이슈, 관련 메모리 항목을 함께 제공해 GPT-5의 긴 컨텍스트를 활용한다.
9. **LLM Ensemble**: Quick tier는 `gpt-5-mini`, Deep tier는 `gpt-5`, Fact-check 류 서브피처는 `gpt-5` + 높은 reasoning effort를 사용해 비용 대비 탐지력을 확보한다.
10. **Metric Tracking**: subfeature hit율, evidence 충족률, Guard/LLM 상태별 이슈 비중(“번역 QA에서도 확인”, “교정 AI만 발견”, “QA 자동 점검만 발견”), 메모리 위반 탐지 수 등을 수집해 튜닝 지표로 활용한다.

## 6. 저장 및 리포트 구조 (BDM)
- Mongo `proofreading_files` 문서는 다음 구조를 가진다:
  - `proofreading_id`, `tierReports`, `report`(최종), Spec snapshot, guard 노트.
- Postgres `proofreading_history` / `proofread_runs` 테이블은 작업 상태·중복 방지·메모리 버전 추적을 담당.
- 보고서는 Proofread Editor/품질 리포트/내부 분석에서 재사용되므로, Responses meta 필드를 `report.meta.llm` 등으로 확장하고 `memoryContextVersion`, `guardAgreementStats`를 함께 저장해야 한다.

## 7. 관측 및 운영 포인트
- 로그: `runProofreading` 단계별 이벤트, `runGenericWorker` LLM 호출 결과/오류, Retry/버짓 증설, Guard 매칭.
- Metrics: 서브피처별 이슈 수, Evidence 충족률, 사용자 친화적 Guard/LLM 상태(“번역 QA에서도 확인”, “교정 AI만 발견”, “QA 자동 점검만 발견”) 비율, 메모리 위반 탐지 수, Quick vs Deep latency.
- 알림: 교정 실패 시 워크플로우 런 상태 업데이트 + 히스토리 `status='error'`.

### 7.1 GPT-5 번역 저품질 사례에서 도출한 예방책
- 참고: `docs/bugreports/2025-10-27-gpt5-translation-low-fidelity.md`.
- **Truncation 감지**: 번역 파이프라인과 동일하게 `truncated=true` 메타가 발견되면 교정 스테이지를 즉시 중단하고 재청크/재시도를 강제한다.
- **청크 크기 관리**: Quick/Deep tier별 기본 청크 수를 토큰 예산에 맞춰 재조정하고, `max_output_tokens` 상향(Quick ≥ 800, Deep ≥ 1,200)과 함께 청크 길이 초과 시 자동 분할을 수행한다.
- **Schema 필수 필드**: Evidence/Source·Severity 등 필드를 `required`에 포함해 Deliberation 단계에서 발생한 누락 오류와 같은 문제가 반복되지 않도록 한다.
- **Observability 확장**: 로그/메트릭에 `truncatedSegments`, `schemaViolationCount`, `retryTokenUpscale`를 기록해 UI·운영 대시보드에서 즉시 확인 가능하게 한다.
- **ENV 기본값 정합성**: `.env`/Spec 파라미터에 GPT-5 전용 `VERBOSITY`, `REASONING_EFFORT`, `MAX_OUTPUT_TOKENS`를 명시해 런타임 불일치로 인한 스키마 오류를 방지한다.

## 8. 로드맵 제안
| 단계 | 작업 | 효과 |
| --- | --- | --- |
| M0 | Responses API 전환, JSON Schema 유닛 테스트 추가 | GPT-5 기반 구조 정착, 파싱 실패 감소 |
| M1 | Spec/ENV 정비, Quick/Deep 파라미터 확정, Observability 개선, evidence 필드 도입 | 운영 안정성 확보, 메모리/증거 기반 교정 준비 |
| M2 | Dual-pass 정렬, Guard/메모리 컨텍스트 통합, Self-consistency 적용 | 이슈 정확도 및 설정 준수 향상 |
| M3 | Rewrite 루프(승인형), Guard↔LLM UI 피드백, Quality 점수 연계 | 번역-교정 통합 품질 상승, 사용자 피드백 루프 구축 |
| M4 | Ensemble/연상형 Guard, KPI 대시보드 제공, 자동 Guard 학습 검토 | 휴먼 수준 상회 목표에 근접 |

## 9. 결론
- GPT-5 Responses API 도입은 교정 파이프라인의 안정성과 표현력을 크게 향상시킬 기반이다.
- Guard, Spec, Project Memory, Quality Evaluation을 교차 연계한 “증거 기반 교정” 체계를 구축하면 휴먼 번역을 뛰어넘는 품질을 실현할 수 있다.
- 본 문서의 설계를 토대로 교정 모듈을 리팩터링하고, 이후 Translation/Quality 모듈과 통합된 학습 루프를 구축하는 것이 앱의 비전 달성에 핵심이다.
