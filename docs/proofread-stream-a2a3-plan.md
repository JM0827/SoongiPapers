# Proofread Stream Hardening (A2/A3) — Implementation Notes

## Context
- **A2**: SSE 내구성 보강 — runId 정합성은 확보했으나 heartbeat, 재연결, 폴링 폴백, 로그가 미구현 상태.
- **A3**: UI 상태머신 & dedupe 개선 — `recovering` 유지, `has_more` 기반 페이지 이어받기, 완료/실패 라벨 정합, zero-item 처리, 테스트 보강 필요.
- 본 문서는 실제 구현에 앞서 코드 레벨 영향을 명확히 하기 위한 작업 메모이며, 변경 전 사전 검토 문서로 활용한다.

## Server-Side Tasks (A2)
1. **SSE Heartbeat + Logging** *(✅ heartbeat 구현, open/close 로그 + 재연결/폴백 메타 수집 포함)*
   - `server/routes/proofreadStream.ts`
     - `setInterval` 기반 3–5s heartbeat 이벤트(`type:"heartbeat"`) 송출.
     - 스트림 open/close 및 heartbeat 전송 실패 시 `request.log.info/warn` 남기기.
     - 클라이언트 구독 식별용 runId/alias 로깅 유지.
2. **Retry & Poll Fallback Hooks** *(✅ 요약/커서 REST 경로 + 스트림 메타 적용 — 실데이터 QA·영속화 남음)*
   - `server/services/proofreadSummary.ts`
     - `getProofreadRunSummary`, `getProofreadItemsSlice`로 요약/페이지 슬라이스 노출.
   - `server/routes/proofreadStream.ts`
     - `/api/projects/:projectId/proofread/summary`, `/api/projects/:projectId/proofread/:runId/items` REST 엔드포인트 추가.
    - 스트림 메타는 in-memory + Postgres(`proofread_stream_metrics`)에 저장되어 대시보드/요약 API에서 재활용.
   - 번역 경로 확장 준비: 동일 패턴을 `translationStreamRoutes` / `translationEvents`에 반영할 수 있도록 구조화.
3. **Zero-item Run Completion Guard** *(✅ 서버 이벤트 강제 및 NDJSON 스냅샷 검증 완료)*
   - stage/tier 실행 후 항목이 0개일 때도 `tier_complete` 및 `complete(scope:"run")`가 확실히 방출되도록 double-check.
   - NDJSON 스냅샷에 zero-item 케이스 추가 (테스트 섹션 참조).

## Client-Side Tasks (A3)
1. **`useProofreadAgent` State Machine** *(✅ 스트림 이벤트 통합 처리 & 요약 폴백 구현 완료 — 재연결 실패 시 REST 요약으로 복구)*
   - `recovering` 유지: sub-stage 오류 및 스트림 오류 동안 run.status=`recovering` 유지, 재시도 실패 시에만 `failed` 전환.
   - Heartbeat 수신 시 `lastHeartbeatAt` 업데이트; 지연되면 `isStalled` true.
   - 재연결 로직: `Proofread run not found` → 한 번만 runId로 재구독, 실패 시 REST 요약(`api.fetchProofreadSummary`)으로 복구.
2. **Pagination & has_more Handling** *(✅ 코드/테스트 정비 완료 — 실데이터 검증 대기)*
   - 서버: `/api/projects/:projectId/proofread/:runId/items` 커서 API는 검증 테스트(`server/services/__tests__/proofreadItemsSlice.test.ts`)와 샘플(`proofreadItemsSlice.sample.ts`)로 회귀 커버리지 확보.
   - 클라이언트: `pendingCursors`/`processedCursors` 큐, 슬라이딩 윈도, zero-item 즉시 완료 처리, 재연결 성공/백오프 Vitest 케이스까지 반영(`useProofreadAgent`).
   - 남은 작업: 실 서비스 런으로 has_more 흐름 QA, 운영 백오프 파라미터 점검.
3. **UI Components**
   - `ProofreadActivityFeed`, `ProofList`
     - `recovering/done/failed` 상태 표시 일관화.
     - zero-item run 즉시 완료 표시.
     - heartbeat/재연결 이벤트 로그 노출(필요 시 새 타입 `heartbeat`/`reconnect`).
4. **Workflow Store**
   - `workflow.store.ts`
     - proofread state에 `pendingCursors`, `needsFollowup` 등 플래그 추가.
     - run/substate 업데이트 시 runId mismatch 방지 (프로젝트 전환 대비).

## Testing & Verification
1. **Server NDJSON Fixtures**
   - 위치: `server/agents/proofreading/__tests__/fixtures/`
   - zero-item run, has_more pagination, retry/recovering 로그를 포함한 스냅샷이 추가되어 stage → items → tier_complete → complete 순서를 회귀 검증합니다 (`pageEnvelope.test.ts`, `proofreadItemsSlice.test.ts`).
2. **Client Vitest** *(✅ 핵심 시나리오 자동화 완료)*
   - `web/src/hooks/useProofreadAgent.test.ts`: zero-item, `has_more` REST 큐, 재연결 실패 폴백, 커서 fetch 실패 `needsFollowup`, 재연결 성공·백오프 해제 시나리오까지 커버.
3. **Manual QA Checklist**
   - 네트워크 끊김(DevTools offline) 후 1회 자동 재연결, 실패 시 폴링으로 마지막 상태 수신.
   - 브라우저 탭을 닫았다가 열었을 때 요약 + 재구독 동작 (Milestone 3 선행 확인 항목으로 기록).

## Dependencies & Notes
- Heartbeat 이벤트는 번역 파이프라인에도 동일하게 도입될 예정이므로, `proofreadEvents` 구조는 generic하게 설계.
- REST 폴링 엔드포인트는 아직 없으므로, Proofread Run Summary API (`GET /api/proofread/:runId/summary`) 정의 필요.
- 서버 로그/메트릭 변경 시 ops와 공유하여 Kibana/Grafana 대시보드 업데이트.
  - SSE 종료 시 `[ProofSSE] stream metrics snapshot` 로그가 남도록 연동되어 있으며, Postgres `proofread_stream_metrics` 테이블에 누적.

_Last reviewed: 2025-11-03 (실데이터 QA 및 운영 메타 영속화 진행 중)_
