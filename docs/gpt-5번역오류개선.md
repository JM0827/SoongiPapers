# GPT-5 번역 파이프라인 품질 개선 계획

## 1. 배경
- GPT-5로 전환한 V2 번역 파이프라인이 최초 실행에서 번역본을 산출했으나, Fidelity 점수가 54점에 불과.
- 로그 분석 결과 드러난 문제점:
  1. Draft/Revise 단계에서 `max_output_tokens` 초과가 잦아 장문의 후반부가 누락됨.
  2. Draft 후보 심사(Deliberation)가 JSON Schema 오류(필수 필드 누락)로 건너뛰면서 후보 비교가 비활성화됨.
  3. Draft 단계에서 truncated 플래그가 true로 남아도 후속 단계가 진행되어 누락된 상태로 Revise/Synthesis가 이어짐.
  4. Coverage guard가 truncated 케이스를 차단하지 못하고, segmentation도 장문을 충분히 쪼개지 못함.

## 2. 개선 목표
- Draft 단계에서 완전한 번역(세그먼트 누락 0) 확보 후 후속 단계로 넘기기.
- Deliberation을 안정적으로 수행해 후보 비교/선택이 이루어지도록 함.
- 토큰 버짓/청크 조정으로 `max_output_tokens` 오류를 최소화.
- Truncated 발생 시 재시도 또는 세분화(run-time guard)로 품질 하락을 미연에 방지.

## 3. 개선 항목 상세

### 3.1 Deliberation 스키마 보강
1. 파일: `server/agents/translation/translationDraftAgent.ts`
2. `deliberationResponseSchema`에서 `analysis` 항목의 item에 대해 `required: ['candidateId', 'summary', 'score']`로 조정.
3. Responses API 호출 시 `text.format`에 사용되는 schema가 수정된 정의를 사용하도록 유지.
4. 변경 후 quick smoke test:
   ```ts
   pnpm ts-node scripts/mockDraftDeliberation.ts
   ```
   (schema 오류가 발생하지 않는지 검증)

### 3.2 Draft truncated guard 도입
1. `generateTranslationDraft` 반환 타입에 이미 포함된 `meta.truncated` 값을 사용.
2. `server/index.ts` → `handleTranslationDraftJob`에서 Draft 결과를 받은 뒤:
   - `draftResult.meta.truncated === true`인 경우 `failureReason = 'draft_truncated';`로 설정하고 `failDraft` 처리.
   - 이후 job 실패로 표시하고, 사용자에게 chunk 재분할 권장 메시지를 전달.
3. 또한 `runMicroChecks` 이전에 truncated 상태 검사를 추가해 안전망 강화.

### 3.3 Chunk/토큰 조정 전략
1. **Segmentation 조정**
   - `server/agents/translation/segmentationAgent.ts`의 `DEFAULT_MAX_SEGMENT_LENGTH`를 기존 2000에서 1400~1600 사이로 축소.
   - 고유 Segment가 지나치게 길 경우 `chunkLongText` 로직에서 한 번 더 분할하도록 보조.
2. **토큰 캡 확장**
   - `.env`에서 `TRANSLATION_DRAFT_MAX_OUTPUT_TOKENS_V2=2200`, `TRANSLATION_DRAFT_MAX_OUTPUT_TOKENS_CAP_V2=6400`으로 이미 조정됨.
   - 필요 시 `TRANSLATION_REVISE_MAX_OUTPUT_TOKENS_V2/ CAP`도 +20% 상향 고려.
3. **재시도 로직**
   - Draft/Revise agent의 `requestDraftCandidate`/`generateTranslationRevision`에 이미 존재하는 max-token doubling 로직 확인.
   - 마지막 시도에 도달했을 때도 truncated가 true라면 `throw` 해서 다음 번 chunk 조정을 유도.

### 3.4 Coverage Guard 강화
1. Draft 결과 meta 수집 시 `meta.truncated`, `meta.fallbackModelUsed`, `meta.retryCount`를 `translation_drafts` DB에 저장.
2. `runMicroChecks`나 후속 Stage에서 meta를 참고하여 truncated segment를 발견하면 `needs_review`를 true로 설정.
3. UI(Proofread/Workflow)에서 truncated 여부를 표시해 운영자가 즉시 확인 가능하도록 로그 노출.

### 3.5 Observability 확장
1. `recordTokenUsage` 호출에 meta 정보를 추가:
   ```ts
   await recordTokenUsage(app.log, {
     ...,
     metadata: {
       verbosity: draftResult.meta.verbosity,
       reasoningEffort: draftResult.meta.reasoningEffort,
       maxOutputTokens: draftResult.meta.maxOutputTokens,
       retryCount: draftResult.meta.retryCount,
       truncated: draftResult.meta.truncated,
       fallbackModelUsed: draftResult.meta.fallbackModelUsed,
     },
   });
   ```
2. `token_usage_events` 테이블에 `metadata JSONB` 컬럼 추가 (데이터베이스 마이그레이션 필요).
3. 대시보드/로그에서 truncated 이벤트 알림 설정.

### 3.6 프로세스 재시나리오
- Draft 실패(누락) → segmentation 조정 → Draft 재시도.
- Draft 성공 but truncated marker → UI 또는 워커에서 재시작 요청.
- Revise/Synthesis 실행 전 truncated 검증.

## 4. 작업 순서
1. Deliberation 스키마 수정 + 코드 반영.
2. Draft truncated guard 추가 (`handleTranslationDraftJob`, `runMicroChecks`).
3. Segmentation/토큰 조정 (최대 길이/캡 수정, 재시도 로직 확인).
4. Observability 확장 (token usage meta, DB 마이그레이션 필요 시 별도 스크립트).
5. 스테이징에서 긴 원문으로 재실행 → Draft truncated 여부 확인.
6. Fidelity 재점검 (목표 ≥ 90) 후 교정(GPT-5) 전환 작업으로 이동.

## 5. 성공 지표
- Draft truncated 발생률 < 1%.
- Deliberation schema 오류 미발생.
- Fidelity ≥ 90.
- truncated/버짓 관련 경고가 관측 대시보드에서 해소.

---
문서 버전: 2025-10-27 (GPT-5 번역 개선 계획)

---

## 부록: GPT-5 전환 시 일반 권고사항 & 주의점

### A. Responses API 공통 준수사항
- `text.format`에 JSON Schema를 지정할 때 `additionalProperties: false`와 `required` 배열에 모든 필드를 명시한다. (누락 시 400 오류 발생)
- `safeExtractOpenAIResponse` 사용 후 `parsed_json`이 없으면 `text`를 JSON.parse; 실패 시 토큰 버짓 확대 + 보수 파라미터로 재시도한다.
- `max_output_tokens` 부족(`incomplete_details.reason === "max_output_tokens"`)이 감지되면 토큰 상한을 1.5~2배까지 증설하고, 동일 작업을 보수 값(verbosity='low', effort='minimal')으로 재시도한다.
- `fallback_model`을 미리 지정해 GPT-5 mini 등 빠른 모델로 회피할 수 있는 경로를 유지한다.

### B. 토큰/청크 관리 팁
- Segment 길이가 길어지면 버짓을 늘리기보다 chunk 자체를 쪼개는 것이 fidelity 확보에 효과적.
- Truncated 플래그가 true인 경우 후속 스테이지(Revise/Synthesis)로 넘기지 않고 재시도/분할하도록 가드 로직을 넣는다.
- `analysis_meta`에 retry 횟수, truncated 여부 등 메타 데이터를 저장하고 observability에서 감시한다.

### C. 스키마 & 재시도 레슨 learned
- Deliberation/Revise/Synthesis 등 모든 응답 스키마에 optional 필드까지 `required`에 포함. (예: `score`, `commentary`, `notes`)
- 반복적으로 쓰는 schema/Responses builder는 공통 helper로 관리해 코드 중복을 줄이고 실수를 방지한다.
- 단순 400 오류 로그만 남기지 말고, 어떤 필드가 누락되었는지 알 수 있도록 preview/logging을 추가한다.

### D. 테스트 & 모니터링
- 변경 후에는 짧은 샘플 텍스트로 스모크 테스트(번역 → profile → 교정) 전체를 돌려 schema/토큰 문제가 없는지 확인한다.
- Observability 대시보드에 `max_output_tokens` 증설 이벤트, truncated 발생, fallback 사용 횟수를 표준 항목으로 추가한다.
- fidelity 점수 등 품질 KPI를 90 이상으로 유지하기 위해 chunk length 조정 → Draft 재시도 → Revise/Synthesis 재실행 순서를 문서화하고 팀에 공유한다.

이 부록은 번역·원문·교정 등 GPT-5 전환 전반에 걸쳐 재사용 가능한 안전 가이드로, 향후 단계에서도 참고할 수 있다.
