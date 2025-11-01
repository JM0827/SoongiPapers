# 번역프로세스‑ver2 (ELT‑first, Draft→Revise→Micro‑Check)

> **Why this can surpass human translation (for BDMs)**

- **증거 기반(ELT) 품질 보증**: 모든 문장·스팬 매핑과 수정에는 **근거 링크(SpanPair/Evidence)**가 따라붙어 재현 가능성과 감사 가능성을 확보. 주관적 논쟁 대신 **객관 데이터**로 품질을 합의.
- **계약(Contract) 주도 일관성**: 문체·시제·따옴표·리듬(평균 문장 길이, 표준편차, 쉼표율)을 **수치 계약**으로 관리. 장편 전체에서 사람보다 **더 일관된 톤**을 유지.
- **누락/중복 제로 추적**: 문장 단위 정렬과 커버리지 게이트로 **원문 대비 1:1 매핑**을 강제. 사람이 놓치는 미세 누락·중복을 시스템이 선제 탐지.
- **대용량 스트리밍 안정성**: 50만+자 작품도 **스트리밍·분산 처리**와 이어쓰기 복구로 중단 없이 진행. 휴먼 파이프라인보다 **시간·비용 예측성**이 높음.
- **스냅샷/Undo 100**: 모든 변경을 버전·감사 로그로 기록해 **대담한 자동 수정**도 안전하게 시도. 협업·리뷰의 비용을 구조적으로 절감.
- **지속적 KPI 운영**: 커버리지, 용어 준수, 리듬 편차, 정렬 품질, Human‑delta 등 **지속측정·회귀 테스트**로 품질을 매번 상승시키는 **학습 루프** 구축.

> **Algorithms & Techniques we apply (for TDMs)**

- **Segmentation/Indexing**: 문장 경계 + 토큰 하드캡(≤1k~1.2k tok), BLAKE3 해시, 정규화 파이프라인.
- **Hybrid Alignment**: 다국어 문장 임베딩(예: e5‑mistral‑multilingual, LaBSE 등 유사 계열) + 토큰 정렬(서브워드 레벨 **Needleman‑Wunsch/Levenshtein** 변형) + 양방향 필터/길이·구두점 휴리스틱 → **SpanPair** 산출.
- **Contract Enforcers**: 용어 락(정규식/Trie + 후보 생성), 리듬 튜너(문장 길이/쉼표율 통계 기반 재구성), 톤 키퍼(블랙리스트/스타일 n‑gram).
- **LLM IO 규약**: Draft=`text` + **continue 프로토콜**, Revise/Micro‑Check=`json_schema(strict)` 함수형 파서.
- **Throughput/Safety**: BullMQ **at‑least‑once** + 멱등 키, 백프레셔, 동적 `max_output_tokens`(\~in\*1.3+overhead, CAP), 후보수 n=1 고정.
- **Storage**: Postgres(메타/계약/이슈/감사), Mongo(LLM 로그/스냅샷), VectorDB(정렬 캐시), Object Storage(원문/결과/자산).

**Status**: v0.1 (codex 설계 초안)  
**Scope**: KO→EN 우선. 대용량(50만+자) 작품 스트리밍 처리, 문장/스팬 정렬, 근거(ELT) 기반 품질 보증.

---

## Trust & Validation (for codex & reviewers)

### Code‑agnostic 원칙

- 문서는 **아키텍처/프로토콜/스키마/KPI**만을 규정한다. 구현은 기능 플래그와 호환 어댑터로 **점진 도입**한다.
- 모든 변경은 **관측 가능한 로그/KPI**로 검증한다. 통과 못 하면 설계를 수정한다.

### 3) 레포 검증 체크리스트 (5분 컷)

1. **드래프트 경로 JSON 파싱 금지**  
   `server/agents/translation/translationDraftAgent.ts` 및 하위에서 `JSON.parse(` 검색 → **있으면 제거 대상**.
2. **던지지 않는 추출기**  
   `safeExtractOpenAIResponse`가 `throw` 대신 `finish` 플래그를 반환하는지 확인.
3. **텍스트→레거시 변환 어댑터 존재**  
   `toLegacyDraftJson(...)` 계층이 있고, 드래프트 외부 계약(JSON)이 **변경 없이 유지**되는지.
4. **기능 플래그**  
   `.env`에 `TRANSLATION_DRAFT_OUTPUT_MODE=json`, `TRANSLATION_ENABLE_CONTINUE=true`가 존재.
5. **후보 수 1**  
   드래프트 호출부에 `n`/`candidateCount` 사용 안 함(=1 고정).
6. **세그먼트 하드캡**  
   `SEGMENTATION_MAX_SEGMENT_LENGTH_V2`가 **1,000~1,200 토큰** 근처.

### 4) 스모크 테스트(코드 몰라도 통과해야 하는 관측)

- 입력: **토큰 많은 문단 3개**.
- 로그 관측:
  - 드래프트 호출 후 `finish=max_output_tokens` → **이어쓰기 호출** 1~3회 발생.
  - 최종 상태: **성공** (더 이상 `draft_truncated` 없음).
  - 드래프트 경로 **JSON 파싱 예외 0건**.
  - 외부 소비자(커버리지/모니터링/QA)는 **기존 JSON**을 계속 수신(어댑터 덕분).

### 5) 수용기준(통과하면 설계가 맞다는 증거)

- **에러 제거**:  
  `Unterminated string in JSON`/`Unexpected end of JSON` → **0건**.  
  `draft_truncated` → **0건**(또는 ≤ 0.5%로 급감).
- **토큰 안전성**:  
  각 드래프트 요청의 `max_output_tokens`가 **동적 산정식(in\*1.3 + overhead, CAP)**으로 기록.
- **호환성**:  
  기존 대시보드/커버리지/QA 파이프라인이 **중단 없이 동작**(어댑터 JSON 소비).

### 6) 실패 시 롤백 안전장치

- 기능 플래그 한 줄로 즉시 복귀: `TRANSLATION_DRAFT_OUTPUT_MODE=json` → 기존 경로.
- 변경 침습 범위는 **어댑터/추출기**에 국한. 표면적 변경만 되돌리면 복구.

### 오류 ↔ 근본 해결 매핑표

- **`JSON.parse` 예외(드래프트)** → 드래프트는 **text만** 수신, 파싱은 Revise/Micro‑Check **strict JSON**에서 수행.
- **`max_output_tokens` 반복 잘림** → **continue 프로토콜 + 동적 max_out**(in\*1.3 + overhead, CAP).
- **레거시 소비자 의존** → **텍스트→레거시 JSON 어댑터**로 외부 계약 유지.

---

## 0) 목표와 원칙

> **How V2 eliminates current failures**

- **`Unterminated string in JSON` 근본 해소**: Draft 단계 **JSON 파싱 제거** → `response_format: text`로만 수신, 파싱은 Revise/Micro‑Check에서 **strict JSON**으로 수행.
- **`max_output_tokens` 반복 잘림 해소**: Draft에 **이어쓰기(continue) 루프**를 내장(“남은 부분만, 반복 금지”), 동적 `max_out=clamp(ceil(in*1.3)+overhead, CAP)` 적용.
- **세그먼트 과대·후보 난립 억제**: 입력 **≤1k~1.2k tok** 하드캡, **n=1 고정**, 원문 에코/설명 금지 프롬프트로 출력 길이 제어.
- **레거시 소비자 호환**: 내부 텍스트 출력 → **레거시 JSON 어댑터**로 변환해 커버리지 가드/모니터링/QA를 그대로 살림.
- **프로파일/드래프트/정렬 분리**: 긴 문서도 스트리밍으로 견고하게 처리하고, 정렬 실패 구간은 Micro‑Check 대기열로 격리.

## 0) 목표와 원칙

- **사람보다 뛰어난 번역 품질**을 증거(ELT)와 수치(KPI)로 재현 가능하게 한다.
- **문장·스팬 정렬(SpanPair)**을 데이터 모델의 1급 개체로 고정, 모든 이슈/수정은 근거 링크를 가진다.
- Draft는 **짧고 안전**(텍스트), Revise/Micro‑Check는 **엄격한 JSON**(strict schema)로 실행한다.
- 파이프라인은 **스트리밍·분산** 처리로 대문서에서도 견고하게 동작한다.

---

## 1) 데이터 모델 (핵심 스키마)

### 1.1 식별/버전/해시

- `work_id` → `section_id` → `para_id` → `sent_id` 4단 체계.
- `content_hash = blake3(normalized_text)`로 변경/중복 추적.
- 버전: `work_version_id`, `snapshot_id`(Undo/Redo 100 지원).

### 1.2 문장/스팬 정렬 (SpanPair)

```json
SpanPair {
  "pair_id": "uuid",
  "work_id": "...",
  "section_id": "...",
  "para_id": "...",
  "source": { "sent_id": "s-00123", "start": 12, "end": 37, "text": "..." },
  "target": { "sent_id": "t-00123", "start": 9,  "end": 30, "text": "..." },
  "align_score": { "token": 0.87, "embed": 0.91, "hybrid": 0.90 },
  "method": ["embed-align","token-align"],
  "created_at": "...", "updated_at": "..."
}
```

### 1.3 근거(Evidence) & 감사 로그(Audit)

```json
Evidence {
  "evidence_id": "uuid",
  "span_pair_ids": ["pair-...","pair-..."],
  "type": "term|idiom|culture|tense|tone|ellipsis",
  "note": "1-line rationale",
  "confidence": 0.0
}
Audit {
  "event_id": "uuid",
  "work_id": "...",
  "actor": "agent|user",
  "action": "draft|revise|term-lock|undo|merge|split",
  "before_hash": "...", "after_hash": "...",
  "payload": {"diff":"…"}, "timestamp": "…"
}
```

### 1.4 계약(Contract) — Style DNA & Glossary Lock

```json
StyleContract {
  "contract_id":"uuid", "work_id":"...",
  "register":"literary-contemporary",
  "tense":"past-simple",
  "dialogue":"US-quotes",
  "cadence_target": { "avg_len": 16, "std": 6, "comma_rate": 0.14 },
  "forbidden": ["archaic","translator-notes"],
  "glossary_lock": [{ "ko":"한강", "en":"Han River" }, {"ko":"종로","en":"Jongno"}]
}
```

---

## 2) 스트리밍 인게스트 & 세그멘테이션

### 2.1 파이프라인(스트림)

```
Reader → Normalizer → Segmenter → SentenceIndexer → Queue(BullMQ)
```

- 문장 경계 + 토큰 상한 **≤ 1,000~1,200 tok** (오버랩 10~15%).
- 각 `sent_id` 즉시 발행 → Draft 워커들이 병렬 소비.

### 2.2 업로드 즉시 **프로파일 카드**

- 장르 후보, 고유명/지명/시대어, 난이도(문장 길이/K‑특수표현률), 리듬 기본값.
- StyleContract 초안 제안 → 사용자 확정.

---

## 3) Draft 단계 (텍스트 생성 + 이어쓰기)

### 3.1 정책

- 출력은 **번역문 텍스트 한 덩어리**. 원문 에코/설명/노트 금지.
- 입력에는 **Glossary‑Lock Top‑K**, **StyleContract 요약**, **금지 규칙**만 압축 주입.
- `finish = max_output_tokens` 시 **continue** 프로토콜로 남은 부분만 이어서 생성.

### 3.2 LLM 호출 규약 (Responses API)

```ts
max_out = clamp(ceil(in_tokens * 1.3) + overhead, CAP);
// Draft: response_format: { type: "text" }
// Continue: same conversation, "Do NOT repeat previous output. Return only the remaining continuation."
```

### 3.3 Draft→Legacy 어댑터 (외부 계약 유지)

- 내부는 텍스트로 생성하되, 외부 소비자(커버리지/모니터링/QA)를 위해 **기존 JSON 스키마**로 래핑.

---

## 4) 자동 정렬기 (Hybrid Aligner)

1. **문장 임베딩**(다국어)로 창 기반 1차 후보 매칭(코사인).
2. **토큰 정렬**(서브워드, e.g., LF‑align): 오프셋 보정.
3. 양방향 일치 + 길이/구두점 휴리스틱 결합 → **SpanPair 확정**.

- 낮은 `hybrid` 점수는 **검사 대기열**(Micro‑Check)로 푸시.

---

## 5) Revise 단계 (계약 준수·리듬 보정·ELT 확정)

### 5.1 입력/출력 (strict JSON)

```json
{
  "translation": "최종 텍스트",
  "fixes": [
    { "sent_id": "t-00123", "type": "glossary", "before": "…", "after": "…" }
  ],
  "resync": [{ "old_sent_id": "t-00099", "new_sent_id": "t-00100" }]
}
```

### 5.2 알고리즘 컴포넌트

- **Glossary Enforcer**: 락 위반 탐지→자동 치환.
- **Rhythm Tuner**: `cadence_target` 편차 보정(문장 길이, 쉼표율 등).
- **Tone Keeper**: 금지 어조/어휘 블랙리스트 교정.
- 수정 후 영향 문장만 **SpanPair 재계산**(증분 업데이트).

---

## 6) Micro‑Check (문장 품질 게이트)

- **Rule‑Check**: 따옴표/괄호 짝, dash/ellipsis, 숫자·단위, 띄어쓰기/대문자.
- **Coverage‑Check**: 원문↔번역 문장 동등성, 누락/중복 감지.
- **Consistency‑Check**: 고유명/반복 구간 일관성.
- **Evidence‑Check**: 모든 이슈에 **SpanPair/Evidence 링크** 필수.
- 출력(JSON): `issues[]`, `auto_fixes?` → 일괄 적용/Undo.

---

## 7) 스냅샷/Undo 100 & Evidence UI

- 모든 변경을 Audit Event로 저장 → **스냅샷/Undo 100**.
- UI: 양문 동기 하이라이트(SpanPair hover), Evidence Drawer(근거·타임라인), 계약 편차 히트맵.

---

## 8) 컴퓨팅/스토리지 배치

- **PostgreSQL**: Work/Section/Para/Sentence 메타, Audit, Contracts, Issues.
- **MongoDB**: LLM 로그, 중간 산출(초안/리비전 스냅샷).
- **Vector DB**: 문장 임베딩(정렬/검색 캐시).
- **Object Storage**: 업로드 원문, PDF/EPUB/마케 자산.

---

## 9) 서비스/워커 토폴로지

- `ingest-svc`(PDF/HWP → 텍스트), `segmenter-svc`, `indexer-svc`, `draft-worker`, `aligner-worker`, `revise-worker`, `microcheck-worker`, `snapshot-svc`, `kpi-svc`.
- BullMQ 큐: `sentences:ingest`, `draft:jobs`, `align:jobs`, `revise:jobs`, `micro:jobs`.

---

## 10) LLM 호출 표준 (함수형 파서)

- Draft: `response_format: { type: "text" }` (continue 포함).
- Revise/Micro‑Check: `response_format: { type: "json_schema", strict: true }`만 허용.
- `safeExtractOpenAIResponse(resp) -> { text, parsedJson?, finish }` (throw 금지, finish로 분기).

### 10.1 모델 & 런타임 프리셋 (명시)

**공통 기본값**: 모델은 **gpt-5** 사용, `temperature`는 모델 기본(1) 유지.

- **Draft**
  - `model`: **gpt-5**
  - `response_format`: `text`
  - `verbosity`: **low**
  - `reasoning.effort`: **medium**
  - `max_output_tokens`: 동적(`ceil(in_tokens*1.3)+overhead`, CAP)

- **Revise**
  - `model`: **gpt-5**
  - `response_format`: `json_schema(strict)`
  - `verbosity`: **medium**
  - `reasoning.effort`: **low**
  - `max_output_tokens`: 동적(입력 길이 기반, CAP)

- **Micro‑Check**
  - `model`: **gpt-5** _(비용 절감 필요 시 gpt-5-mini로 대체 가능)_
  - `response_format`: `json_schema(strict)`
  - `verbosity`: **low**
  - `reasoning.effort`: **low**
  - `max_output_tokens`: 짧은 이슈 JSON(엄격 상한)
- Draft: `response_format: { type: "text" }` (continue 포함).
- Revise/Micro‑Check: `response_format: { type: "json_schema", strict: true }`만 허용.
- `safeExtractOpenAIResponse(resp) -> { text, parsedJson?, finish }` (throw 금지, finish로 분기).

---

## 11) 토큰/비용 제어

```txt
max_out = clamp(ceil(in_tokens * 1.3) + overhead, CAP)
Continue: overhead = 700 + 300 * attempt, mult = 1.35
Segments: input ≤ 1,000~1,200 tok, overlap 10–15%
```

- 후보수(n) = 1 고정. 원문 에코/설명 금지. Glossary/Notes는 입력 축약본만.

---

## 12) ENV (권장 기본값)

```env
SEGMENTATION_MAX_SEGMENT_LENGTH_V2=1200
SEGMENTATION_MODE_V2=balanced

TRANSLATION_DRAFT_MODEL_V2=gpt-5
TRANSLATION_DRAFT_VERBOSITY_V2=low
TRANSLATION_DRAFT_REASONING_EFFORT_V2=medium
TRANSLATION_DRAFT_MAX_OUTPUT_TOKENS_V2=3200
TRANSLATION_DRAFT_MAX_OUTPUT_TOKENS_CAP_V2=12000

TRANSLATION_REVISE_MODEL_V2=gpt-5
TRANSLATION_REVISE_VERBOSITY_V2=medium
TRANSLATION_REVISE_REASONING_EFFORT_V2=low
TRANSLATION_REVISE_MAX_OUTPUT_TOKENS_V2=2000
TRANSLATION_REVISE_MAX_OUTPUT_TOKENS_CAP_V2=6000

TRANSLATION_MICROCHECK_MODEL_V2=gpt-5 # (옵션) 비용 절감 필요 시 gpt-5-mini
TRANSLATION_MICROCHECK_VERBOSITY_V2=low
TRANSLATION_MICROCHECK_REASONING_EFFORT_V2=low
TRANSLATION_MICROCHECK_MAX_OUTPUT_TOKENS_V2=1024

TRANSLATION_DRAFT_OUTPUT_MODE=json
TRANSLATION_ENABLE_CONTINUE=true
```

---

## 13) API 계약 (요약)

### 13.1 Draft (내부)

- **Req**: `{ work_id, section_id?, para_id?, sent_batch[], style_contract_id, glossary_lock[] }`
- **Res (외부 계약 유지)**: `{ segments: [{ segment_id, origin_segment, translation_segment, notes:[], spanPairs:[] }] }`  
  (내부는 text 생성 후 어댑터로 래핑)

### 13.2 Revise (strict JSON)

- **Req**: `{ work_id, draft_text|segments, style_contract, glossary_lock }`
- **Res**: `{ translation, fixes[], resync[] }`

### 13.3 Micro‑Check (strict JSON)

- **Req**: `{ work_id, translation, span_pairs[], contract }`
- **Res**: `{ issues:[…], auto_fixes? }`

---

## 14) 정렬기 의사코드

```pseudo
function hybrid_align(src_sents[], tgt_sents[]): SpanPair[] {
  E_s = embed(src_sents); E_t = embed(tgt_sents)
  C = cosine_candidates(E_s, E_t, window=W)
  for (c in C): c.refine = token_align(c.src, c.tgt) // subword alignment
  pairs = bidir_select(C, lambda c: score(c.refine, len_penalty, punct_bonus))
  return pairs
}
```

---

## 15) KPI & 모니터링

- **Coverage**: 원문↔번역 문장 매핑율 (= 누락 0%).
- **Glossary Compliance**: 락 용어 위반률.
- **Rhythm Δ**: avg_len/std/쉼표율 편차.
- **Alignment Quality**: hybrid 평균/하위 5% 컷.
- **Human‑delta**(블라인드 샘플): 인적 평가 대비 차이.

---

## 16) 마이그레이션/도입 플랜

1. ELT 스키마(SpanPair/Evidence/Audit) 도입 및 기존 데이터 이관.
2. Segmenter/Indexer 스트리밍화 + 큐 배선.
3. Draft 내부 text+continue 전환, 외부 JSON 어댑터로 호환.
4. Hybrid Aligner 적용, SpanPair 저장/UI 하이라이트.
5. Revise strict JSON + Enforcer/Tuner/Keeper 도입.
6. Micro‑Check 게이트 + Evidence Drawer UI.
7. KPI 대시보드 및 회귀 테스트.

---

## 17) 프롬프트 템플릿(요약)

**Draft(system)**: “KO→EN literary translator. **No source echo. No explanations. English only.** Honor glossary/style.”  
**Draft(continue)**: “Continue from where you left off. **No repetition.** English only.”  
**Revise(system)**: “Return **strict JSON** as per schema. Enforce glossary, tone, cadence.”  
**Micro‑Check(system)**: “Return **strict JSON** issues with evidence links (sent_id/span).”

---

## 18) 테스트 계획(샘플)

- 긴 문단(>2k tok) 세트에 대해 Draft 잘림→Continue 회복률 ≥ 99%.
- Coverage 누락 0%/중복 < 0.2%.
- Glossary 위반률 < 0.5% (Revise 후).
- Hybrid align 하위 5% 점수 문장에 대한 Micro‑Check 경고 95% 이상 검출.

---

## 19) 오픈 이슈

- 문장 임베딩 모델 선택(오픈/상용), 다국어 커버리지.
- 토큰 정렬기 구현 세부(성능/정확도 트레이드오프).
- Scene/Section 스냅샷 자동 추출 기준(클라이맥스, POV 전환 감지).

---

> 이 문서는 codex 리팩터링 가이드의 기준선이다. 다음 PR부터는 **3) Draft 내부 text+continue + 외부 JSON 어댑터**와 **4) Hybrid Aligner 저장/UI**를 우선 대상(Phase‑A)으로 진행한다.
