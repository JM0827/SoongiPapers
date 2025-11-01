# QA Checklist — Translation / Proofread Segment Retry

본 체크리스트는 Milestone 1 안정화 범위(번역 Draft·Revise 및 Proofreading 워커의 세그먼트 재시도 흐름)에 대한 수동 검증 절차를 정의합니다. 각 항목 완료 시 `✅` 표시와 테스트 로그/티켓 링크를 남겨 주세요.

## 1. Truncation 복구 (번역 Draft)
- [ ] 테스트 데이터: 4문장 이상, 길이 2,400자 이상 원문으로 `max_output_tokens` 제한을 유도
- [ ] `TRANSLATION_V2_DEBUG=true` 상태에서 Draft 호출한 후, 로그에 `segment retry` 단계가 기록되는지 확인
- [ ] 재시도 후 최종 응답 `meta.truncated === false`, `meta.retryCount >= 1` 인지 검증
- [ ] 합성 응답 텍스트 품질 스팟 체크(문장 누락/중복 없음)

## 2. Truncation 복구 (번역 Revise)
- [ ] Draft 단계 결과를 입력값으로 사용, 동일한 truncation 조건 재현
- [ ] Revise 로그에 `segment retry`가 발생했으며 `llm.runs`가 2건 이상 기록되는지 확인
- [ ] 최종 `jsonRepairApplied`, `fallbackModelUsed` 플래그 값 검증
- [ ] 결과 텍스트가 Draft 대비 자연스럽게 정제되었는지 리뷰

## 3. Proofreading Segment Retry 동작
- [ ] 길이 3,000자 이상 번역문으로 교정 실행 → `runGenericWorker`가 세그먼트 분할 후 재시도 수행
- [ ] 로그에 `proof-segment-retry` synthetic response와 `attemptHistory` merge 기록이 남는지 확인
- [ ] UI 상 run/subStates에 `recovering` -> `done` 흐름이 표시되는지 확인 (Timeline, Sidebar 모두)
- [ ] 결과 아이템 수, 메타(`attempts`, `truncated`, `usage`)가 합산되어 저장되는지 DB 스니핑 혹은 API 응답으로 점검

## 4. 오류 회귀 검증
- [ ] 강제 429 시뮬레이션(프록시 또는 모의 응답)으로 번역/교정 모두 재시도 유지되는지 확인
- [ ] JSON 파싱 실패(불완전 JSON 주입) 시 `jsonRepairApplied` 플래그가 true로 표시되고 런이 복구되는지 확인

## 5. 회귀 테스트 보고
- [ ] 테스트 로그 정리 및 스냅샷 첨부 → QA 위키/티켓 업데이트
- [ ] 발견된 이슈는 `translation-proofread-retry` 라벨로 트래킹

> 참고: 테스트 동안 lint/format 스크립트가 단축 모드로 실행되지 않았는지 확인하고, 필요시 `npm run lint --workspace=server` 전체 실행 결과를 첨부합니다.
