# Response v2 Schema & Pagination Design

## 배경
- Proofreading/Translation 파이프라인이 JSON 스키마에 따라 증거 텍스트와 수십 개 항목을 한 번에 반환하면서 `max_output_tokens`에 반복적으로 도달함.
- Truncation 복구를 위해 토큰 캡을 확장했지만, 근본적으로는 출력 페이로드를 슬림화하고 여러 번 나눠 받는 구조가 필요함.
- Milestone 2 목표(성능·비용 개선)를 위해 다음 변경을 공통으로 설계한다.

## 목표
1. **응답 v2 스키마 정의** – evidence를 텍스트 대신 인덱스로 표현하고, 키를 단축해 NDJSON 크기를 줄인다.
2. **페이징/커서 프로토콜 도입** – 한 호출당 `max_items`를 제한하고 `has_more`/`next_cursor`로 이어받는다.
3. **토큰 산정/재시도 전략 재설계** – 필요량 추정 → 상한 적용, 재시도 시 토큰·아이템 수를 줄이는 다운시프트 패턴 채택.
4. **전 파이프라인 적용** – 번역 Draft/Revise, Proofreading, Quality, Profile 등 공통 응답 파서에 동일 규칙을 반영.

## v2 JSON Schema (초안)
### 스키마 개요
- **증거 텍스트 금지**: 원문/번역 문자열 복제 없이 **문장 인덱스(i)**, **문자 오프셋(o)** 만 반환
- **결정적 페이징**: `has_more`/`next_cursor` 지원, `run_id+cursor` 멱등
- **운영 메타 상단 포함**: 지연, 토큰 사용, 재시도 상황을 응답 1회로 파악

### AgentItemsV2
```ts
export interface AgentItemsV2 {
  version: "v2";
  run_id: string;
  chunk_id: string;
  tier: "quick"|"deep";
  model: string;
  latency_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  finish_reason?: "stop"|"length"|"content_filter"|"error";
  truncated: boolean;
  partial?: boolean;
  warnings?: string[];

  index_base: 0|1;                  // 기본 0
  offset_semantics: "[start,end)";  // UTF-16 code unit 기준
  stats?: { item_count: number; avg_item_bytes?: number };

  items: AgentItem[];
  has_more: boolean;
  next_cursor: string | null;
}
```

### AgentItem
```ts
export interface AgentItem {
  uid?: string; // sha1(k|i|o|rule_id)
  k: string;    // key: "grammar_spelling_punct" 등
  s: "error"|"warning"|"suggestion";
  r: string;    // ≤160 chars
  t: "replace"|"insert"|"delete"|"note";
  i: [number, number]; // sentence index range
  o: [number, number]; // char offsets [start,end)

  // 확장(옵션)
  cid?: string;
  rule_id?: string;
  conf?: number; // 0..1
  lang?: "ko"|"en"|string;
  side?: "src"|"tgt"|"both";
  fix?: { text?: string; note?: string }; // 필요한 단계에서만
}
```

### 제약
- `additionalProperties: false`
- 문자열 상한: `r ≤ 160`, `fix.note ≤ 120` (서버에서 컷오프)


### v1 대비 핵심 변경
| 영역 | v1 | v2 |
| --- | --- | --- |
| Evidence | 원문/번역 텍스트를 그대로 포함 | 문장 인덱스 `i` + 문자 오프셋 `o`만 반환 |
| Item 배열 | `key`, `severity`, `message`, `evidence` 등 긴 속성명 | 축약 키(`k`, `s`, `r`, `t`, `i`, `o`)와 선택 필드만 유지 |
| 페이징 | 전체 응답 1회 송신, truncation 시 JSON Repair 의존 | `limit` 기반 다회 호출, `has_more/next_cursor`로 이어받기 |
| 재시도 전략 | 토큰 상향/모델 확장 중심 | 토큰·아이템 다운시프트 → 청크 분할 → 종료 강제 |
| 메타데이터 | 일부 단계별 개별 구조 | 공통 상단 메타(`run_id`, `chunk_id`, `tier`, `latency_ms` 등) 통일 |


### NDJSON 스트림 구조
- 모든 응답은 NDJSON 라인 단위로 송신되며 `type` 필드로 구분한다.
- `items` 레코드는 위 `AgentItemsV2` 스키마를 따르고, `stage`/`progress`/`complete`/`end`는 경량 메타만 포함한다.
- 예시:

```json
{"type":"stage","data":{"run_id":"run_abc","stage":"draft","status":"in_progress","label":"Draft"}}
{"type":"items","data":{"version":"v2","run_id":"run_abc","chunk_id":"seg-01","items":[{"k":"grammar","s":"error","r":"Fix verb agreement","t":"replace","i":[3,3],"o":[120,135]}],"has_more":true,"next_cursor":"seg-01:1"}}
{"type":"progress","data":{"run_id":"run_abc","chunk_id":"seg-01","emitted":32,"has_more":true}}
{"type":"complete","data":{"run_id":"run_abc","completedAt":"2025-01-12T08:12:31.000Z"}}
{"type":"end","data":{"run_id":"run_abc","completed":false,"reason":"has_more"}}
```
- 서버는 `type=items`일 때만 `items` 배열을 포함하며, 그 외 메시지는 UI 진행률/로그에 사용한다.

#### 이벤트 타입
| type | 설명 | data 필드 |
| --- | --- | --- |
| `stage` | 단계 상태 업데이트 | `{ run_id, chunk_id?, stage, status: "queued"\|"in_progress"\|"done"\|"error", label, itemCount?, message? }` |
| `items` | v2 페이지 페이로드 | `AgentItemsV2` (상단 메타 + items) |
| `progress` | 진행률 숫자/카운터 | `{ run_id, chunk_id?, emitted, total?, has_more? }` |
| `complete` | 전체 작업 완료 | `{ run_id, completedAt, translationFileId? }` |
| `error` | 복구 불가 오류 | `{ run_id, stage?, message, retryable }` |
| `end` | 스트림 종료 시그널 | `{ run_id, completed: boolean, reason? }`

- `stage` 이벤트는 UI 타임라인/배지에 사용되며, `chunk_id`는 단계별로 필요할 때만 채운다.
- `progress`는 Proofread/Translation 모두에서 재사용 가능한 숫자 기반 진행 지표를 제공한다.
- `complete`와 `end`는 서로 다른 용도(비즈니스 완료 vs 전송 종료)를 가지며 둘 다 전송한다.
- 신규 타입이 추가되면 클라이언트 파서는 `type` 분기에서 graceful fallback 하도록 구현한다.


## 프롬프트 가이드라인 변경 (예시)
- Do **NOT** copy any source/target text. Return **indexes only** (i, o).
- Limit to **<= ${limit} items**; if more issues remain, set **has_more=true** and **next_cursor**.
- Keep each recommendation **<= 160 characters**; do not include examples or quotes.

### 단계별 추가 지침
| Stage | 주요 포인트 |
| --- | --- |
| Translation Draft | `cid`로 세그먼트 ID를 포함하여 후속 Revise가 동일 범위를 참조할 수 있게 한다. `fix.text`는 미사용. |
| Translation Revise | Draft 결과 대비 변경이 필요할 때만 `fix.text`를 포함한다. Draft가 `has_more=true`인 상태에서는 Revise가 같은 커서를 재사용하지 않는다. |
| Proofread Quick | `tier="quick"` 설정, grammar/spelling/terminology 등 핵심 규칙만 보고한다. `warnings` 배열에 cutoff, 추정치 등을 포함한다. |
| Proofread Deep | 추가 스타일/톤 피드백 허용, 단 `r` 160자 제한 엄수. `fix.note`는 UI 툴팁에 노출되므로 2문장을 넘지 않는다. |
| Quality Score | 범위 기반 증거는 `side="tgt"`로 통일, 정량 점수는 별도 `stats`에서 노출한다. |

### Tier & Stage Semantics
- Proofread 계열: `tier`는 `"quick"` 또는 `"deep"`을 유지하며, `chunk_id`는 `chunk-${n}` 형식으로 증가한다.
- Translation 계열: `tier`는 단계명을 그대로 사용(`"draft"`, `"revise"`, `"micro-check"`), `chunk_id`는 `stage:${jobId}` 또는 페이징 시 `stage:${jobId}:${cursor}` 형태를 권장한다.
- Quality/Other 파이프라인은 `tier`에 자유 문자열을 사용할 수 있지만, 대시보드 필터링을 위해 사전 정의 목록을 문서화한다.
- `stats.item_count`는 단일 페이지 내 항목 수를 기록하고, 페이징 총합은 클라이언트에서 누적한다.


## Pagination & Retry
### 페이징
- 요청: `cursor`, `limit` (quick 기본 32, deep 48)
- 응답: `has_more`, `next_cursor` (서버 생성, 불투명 문자열)
- **멱등성**: 동일 `run_id+cursor` → 동일 `items`

#### Cursor 구성 규칙
- 서버는 `next_cursor`를 `<chunk_id>:<offset>` SHA256 → base64 등의 불투명 문자열로 인코딩한다.
- 클라이언트는 문자열 전체를 그대로 `cursor`로 되돌려야 하며 내부 필드를 해석하거나 수정하지 않는다.
- `cursor=null`은 첫 페이지, `cursor=""`는 더 이상 요청할 필요가 없음을 의미한다(서버는 빈 문자열을 반환하지 않도록 권장).
- `has_more=false`이면 `next_cursor`는 `null`을 반환한다.

### 재시도(다운시프트 우선)
1) `finish_reason=length` 또는 `truncated=true` →  
   `limit = floor(limit*0.7)`, `max_output_tokens = floor(max_output_tokens*0.7)`, `attempt_policy="downshift"`  
2) 동일 청크 **분할**(문장/문자 수 기준)  
3) 2회 실패 시 **페이징 강제**(`has_more=true`)로 종료 처리  
※ 상향 재시도(토큰↑/limit↑)는 금지

#### Limit 테이블
| Tier | 1차 요청 | 1회 다운시프트(70 %) | 2회 다운시프트(49 %) |
| --- | --- | --- | --- |
| quick | 32 items / 1,200 tokens | 22 items / 840 tokens | 15 items / 580 tokens |
| deep | 48 items / 1,800 tokens | 33 items / 1,260 tokens | 23 items / 880 tokens |
- 토큰 한도는 추정식 결과와 비교해 더 작은 값을 사용한다.
- 2회 다운시프트 후에도 `length`가 발생하면 `has_more=true`로 끝내고 클라이언트에 재요청을 위임한다.


## Token Estimation Heuristic
- 평균 토큰/항목: quick ≈ 40, deep ≈ 60
- 추정식: `estimated = 80 + predictedIssues * avgTokensPerItem`
- `predictedIssues = clamp(sentenceCount * density, 0, sentenceCount * 0.5)`
- 한도: quick `900–1600`, deep `1400–2200` (CAP은 **최대치**로만 사용)


## Implementation Notes
### Server
- `responsesSchemas.ts`에 `agentItemsResponseV2` Zod/AJV 스키마를 정의하고, v1/v2 공존 기간 동안 `version` 분기를 허용한다.
- `runGenericWorker`는 `limit`과 `max_output_tokens` 파라미터를 입력으로 받고, 응답 메타(`truncated`, `finish_reason`, `warnings`)를 그대로 스트림에 전달한다.
- `next_cursor` 생성 시 run-scoped salt를 포함해 추측 공격을 막는다. (`cursor = base64url(sha256(run_id|chunk_id|offset|salt))`)
- 다운시프트 후 페이징 종료 시 `warnings`에 `"downshift_exhausted"` 태그를 추가해 추후 모니터링할 수 있게 한다.
- Revise/Proofread 등이 아직 v1을 반환할 경우, 서버에서 v2로 변환하는 어댑터를 만들어 점진 전환한다.

### Client
- `web/src/services/sse.ts`에서 `type=items` 라인을 파싱해 `items` 배열을 즉시 store에 머지하고, `has_more=true`이면 자동 추가 호출을 예약한다.
- `workflow.store.ts`는 `run_id+chunk_id` 단위로 Issue Map을 유지하고, 이미 본 `uid`는 중복 삽입하지 않는다.
- 하이라이트 렌더러는 `index_base`와 `offset_semantics`를 함께 고려해 텍스트 위치를 계산한다. 기본값 외 필드가 오면 즉시 로그/Metric을 남긴다.
- UI는 `warnings` 내용을 Debug 패널(또는 QA 모드)에만 노출하고, 일반 사용자에게는 메시지를 축약한다.

### Translation Integration
- Draft/Revise 워커는 응답 당 최소 1개의 `items` 이벤트를 발행하고, 세그먼트 수가 `limit`을 넘으면 후속 호출로 이어간다.
- `run_id`는 Translation Job ID(`translation:${jobId}` 등)를 사용하고, 클라이언트는 Proofread와 동일한 store 슬롯(`translation.pages`)에 적재한다.
- SSE 라우트(`/api/projects/:projectId/translations/stream`)는 `stage` → `items` → `progress` 순으로 이벤트를 보낸 후, 작업 종료 시 `complete`와 `end`를 순차 전송한다.
- Polling 백업을 유지하기 위해 스트림이 끊기면 클라이언트는 기존 REST 엔드포인트를 재호출하고, 재연결 시 `cursor` 값을 그대로 전달한다.

### Telemetry & Ops
- `json_repair_rate`와 별개로 `downshift_count`, `forced_pagination_count`, `cursor_retry_count`를 통계로 집계한다.
- `latency_ms`, `prompt_tokens`, `completion_tokens`를 stage/tier 별로 export하여 KPI 대시보드에 포함한다.
- `has_more=true` 케이스의 후속 호출 성공률을 집계해, 필요 시 limit 초기값을 조정할 수 있게 한다.
- 실패 이벤트(`finish_reason="error"`)는 `partial=true` 플래그와 함께 알림 슬랙 채널에 전송한다.


## Two-Pass & Adaptive Chunking (Roadmap)
**Two-Pass**
- Pass 1 (Detect): `*-mini`로 전범위 스캔, 인덱스/범주 헤더만 수집
- Pass 2 (Fix): 탐지된 범위만 정밀 교정(필요 시 `fix.text` 포함)

**Adaptive Chunking**
- 목표 700–900자, 문장 1–4 유동
- 오버랩 1문장, “뒤 청크 우선” 병합 + `uid` dedup


## 마이그레이션 단계
1) 서버: v2 스키마 타입/검증 추가 → v1/v2 파서 병행 → NDJSON 스트리밍(`stage`/`items`/`progress`/`complete`/`end`) 통일
2) 클라이언트: v2 파싱 및 하이라이트 렌더러(인덱스 기반) 적용
3) Telemetry: `truncated_rate`, `json_repair_rate`, `avg_items_per_resp`, `retry_breakdown` 대시보드
4) 회귀 QA: v1 대비 하이라이트 정확도/누락률/처리시간 비교
5) 롤아웃: 프로젝트/워크플로우 플래그로 점진 적용 (문서 업데이트: 2025-11-01 06:58)


## Open 질문
- 번역 Draft/Revise 단계에서 세그먼트별 range 정보를 일관되게 생성하는 방식?
- Quality 에이전트(정량 평가)는 점수 요약(`stats`)과 범위 evidence를 어떻게 병합할지? 별도 channel 유지 vs v2 확장?
- UI에서 range 기반 하이라이트 구현 시 국제화/RTL 텍스트 고려 사항?
- 중간 저장소(issue map)가 커질 때 `uid` 해시 충돌이나 메모리 제한을 어떻게 감시할지?

## Phase A — Proofread RFC v2.0 (진행 중)
- [x] 모델 response_format을 `proofreading_items_payload_v2_light`로 축소(필수 필드만)
- [x] 서버에서 라이트 페이로드를 리치 페이지로 정규화(`stats`/`metrics`/`warnings`/`next_cursor` 합성)
- [x] OpenAI `truncated` → `has_more=true` + cursor 합성, items → complete 흐름 유지
- [x] NDJSON 핸드셰이크에서 workflow + 초기 stage 즉시 전송
- [ ] Heartbeat(3–5 s)·라우트 로그·SSE 재시도→폴링 폴백 정비
- [ ] UI 상태머신: sub-error 시 `run=recovering`, dedupe 키 `proofreading_id+tier+key+pageIndex`, `has_more=true` 자동 이어받기
- [ ] 아이템 0건이어도 `items` 직후 `complete` 보장, zero-issue 런 스피너 제거
- [ ] RFC v2.0 스냅샷 테스트(CI)와 샘플 NDJSON 리플레이 추가

## 다음 행동
- 서버 (BE)
  - [x] `responsesSchemas.ts`에 `agentItemsResponseV2` 스키마 추가 및 v1/v2 브리지 작성
  - [~] `runGenericWorker`/`runResponsesWithRetry` 다운시프트·cursor 정책 구현 *(강제 pagination까지 반영, metrics/telemetry 기본값 잔여)*
  - [ ] Proofread/Translation Draft·Revise Agent를 v2 페이로드로 전환(필요 시 어댑터)
    - [x] Translation draft/revise 워커에서 v2 envelope 스트리밍 발행
    - [~] Proofread quick/deep 에이전트 v2 이벤트 스트림 적용 *(페이지 metrics·heartbeat 추가 필요)*
  - [x] NDJSON 스트림(`stage`/`items`/`progress`/`complete`/`end`) 통합과 `warnings` 태그 확장 (translation stream)
  - [~] Proofread 전용 SSE 라우트: v2 이벤트 전송 완료, heartbeat/재시도 훅 대기
  - [ ] Telemetry 카운터(`downshift_count`, `forced_pagination_count`, `cursor_retry_count`, `page_count`)와 알림 추가
- 클라이언트 (FE)
  - [~] SSE 파서(`web/src/services/sse.ts`) v2 대응 *(fallback 처리 완료, heartbeat/재시도/자동 폴백 대기)*
  - [ ] `workflow.store` Issue Map을 `proofreading_id+tier+key+pageIndex` 기반으로 리셋하고 중복 방지 로직 강화
  - [ ] Proofread/Translation 하이라이트 컴포넌트가 index/offset을 해석하도록 리팩터링
  - [ ] Retry/다운시프트 상태를 UI(타임라인, Sidebar)에서 배지/툴팁으로 노출
- QA/운영
  - [ ] v1 대비 하이라이트 정확도, 처리 시간, 다운시프트 발생률 리그레션 테스트
  - [ ] KPI 대시보드에 신규 메트릭(토큰, downshift, pagination) 추가 및 알람 설정
