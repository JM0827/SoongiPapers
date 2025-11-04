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


## 프롬프트 가이드라인 변경 (예시)
- Do **NOT** copy any source/target text. Return **indexes only** (i, o).
- Limit to **<= ${limit} items**; if more issues remain, set **has_more=true** and **next_cursor**.
- Keep each recommendation **<= 160 characters**; do not include examples or quotes.


## Pagination & Retry
### 페이징
- 요청: `cursor`, `limit` (quick 기본 32, deep 48)
- 응답: `has_more`, `next_cursor` (서버 생성, 불투명 문자열)
- **멱등성**: 동일 `run_id+cursor` → 동일 `items`

### 재시도(다운시프트 우선)
1) `finish_reason=length` 또는 `truncated=true` →  
   `limit = floor(limit*0.7)`, `max_output_tokens = floor(max_output_tokens*0.7)`, `attempt_policy="downshift"`  
2) 동일 청크 **분할**(문장/문자 수 기준)  
3) 2회 실패 시 **페이징 강제**(`has_more=true`)로 종료 처리  
※ 상향 재시도(토큰↑/limit↑)는 금지


## Token Estimation Heuristic
- 평균 토큰/항목: quick ≈ 40, deep ≈ 60
- 추정식: `estimated = 80 + predictedIssues * avgTokensPerItem`
- `predictedIssues = clamp(sentenceCount * density, 0, sentenceCount * 0.5)`
- 한도: quick `900–1600`, deep `1400–2200` (CAP은 **최대치**로만 사용)


## Two-Pass & Adaptive Chunking (Roadmap)
**Two-Pass**
- Pass 1 (Detect): `*-mini`로 전범위 스캔, 인덱스/범주 헤더만 수집
- Pass 2 (Fix): 탐지된 범위만 정밀 교정(필요 시 `fix.text` 포함)

**Adaptive Chunking**
- 목표 700–900자, 문장 1–4 유동
- 오버랩 1문장, “뒤 청크 우선” 병합 + `uid` dedup


## 마이그레이션 단계
1) 서버: v2 스키마 타입/검증 추가 → v1/v2 파서 병행 → NDJSON 스트리밍( items/progress/end ) 통일
2) 클라이언트: v2 파싱 및 하이라이트 렌더러(인덱스 기반) 적용
3) Telemetry: `truncated_rate`, `json_repair_rate`, `avg_items_per_resp`, `retry_breakdown` 대시보드
4) 회귀 QA: v1 대비 하이라이트 정확도/누락률/처리시간 비교
5) 롤아웃: 프로젝트/워크플로우 플래그로 점진 적용 (문서 업데이트: 2025-11-01 06:58)


## Open 질문
- 번역 Draft/Revise 단계에서 세그먼트별 range 정보를 일관되게 생성하는 방식?
- Quality 에이전트(정량 평가)는 v2 스키마가 아닌 별도 구조라 어떻게 노출/집계할지?
- UI에서 range 기반 하이라이트 구현 시 국제화/RTL 텍스트 고려 사항?

## 다음 행동
- [ ] JSON Schema v2를 `server/services/responsesSchemas.ts`에 추가하고 파서 업데이트
- [ ] Proofreading/Translation 에이전트 v2 응답 생성 구현
- [ ] FE 구조 변경 (SSE 파서, proofread UI 하이라이트) 사전 설계
