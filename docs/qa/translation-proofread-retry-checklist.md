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

## 6. Canonical Summary & Metrics (Step 4.5)
- [ ] 동일한 번역 런에서 `translation_segment_meta` row 수와 `/api/projects/:projectId/translations/summary` 의 `progress.hashes.total` 값이 일치하는지 확인
- [ ] Micro-check 이전에는 `progress.percent` 가 99 %를 초과하지 않고, micro-check 완료 후(guard follow-up 모두 정리) 100 %로 승급되는지 확인
- [ ] Canonical 세그먼트 일부를 강제로 제거/추가한 뒤(테스트 DB) `progress.hashes.processed` 가 즉시 반영되고, SSE 재연결 후에도 요약값이 캐시와 일치하는지 검증
- [ ] `/translations/summary` 응답의 `pagination.cursorHash` 가 SSE/REST pagination cursor(stage:hash)와 동일하며, Proofread Editor 요청 시 다음 페이지 hash 기준으로 재개되는지 확인
- [ ] QA 로그에 사용한 runId, hash 샘플, summary 캡처를 첨부해 회귀 추적이 가능하도록 기록

## 7. Canonical Chunk Processing (Step 4.6)
- [ ] 1,000개 이상 세그먼트를 생성할 수 있는 장문 프로젝트를 실행해 `[segmentation] Persisting canonical segments` 로그가 chunk 당 한 번씩 출력되고, 로그 사이에 BullMQ stall 경고가 발생하지 않는지 확인
- [ ] 실행 중 `translation_v2` 큐의 active job 이 유지되고, `runStatus` / `progress.percent` 가 일정 주기로 갱신되는지 `/api/projects/:id/translations/summary` 로 확인
- [ ] 워커 로그에 `BullMQ job stalled` 경고가 나타나면 lockDuration/stalledInterval 환경값을 기록하고 재현 가능한지 조사
- [ ] canonicalCacheState 가 `running → ready` 로 전환된 이후 chunk 처리 시간이 30초 이상 지속되지 않는지(다른 API가 block 되지 않는지) 모니터링 도구나 health 체크로 확인
- [ ] 잡 실행 직후 `[TRANSLATION_V2] Draft stage completed`, `[TRANSLATION_V2] Micro-check stage completed` 등의 단계 로그가 순차적으로 찍히고, `/translations/summary` 호출이 pending 상태에 묶이지 않는지(캐시 warming → ready) 확인

> 참고: 테스트 동안 lint/format 스크립트가 단축 모드로 실행되지 않았는지 확인하고, 필요시 `npm run lint --workspace=server` 전체 실행 결과를 첨부합니다.
