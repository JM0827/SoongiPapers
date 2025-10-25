// server/agents/qualityAgent.ts
// OpenAI API를 활용해 번역 품질(단일 번역 평가)을 수행하는 모듈
// Fastify 라우트에서 호출해 사용합니다.

import OpenAI from "openai";
import { z } from "zod";

import { SHARED_TRANSLATION_GUIDELINES } from "./prompts/sharedGuidelines";

// ----------------------------- 타입 정의 -----------------------------

// 정량 평가 항목 키
export type QuantKeys =
  | "Fidelity" // 원작 의미 충실성
  | "Fluency" // 영어 문장 유창성
  | "Literary Style" // 문체/톤 재현
  | "Cultural Resonance" // 문화적 공명
  | "Creative Autonomy"; // 창의적 자율성

// 각 항목별 점수와 코멘트 (한/영 지원)
export type QuantScores = Record<
  QuantKeys,
  { score: number; commentary: { ko: string; en: string } }
>;

// 최종 평가 결과 구조
export interface FinalEvaluation {
  overallScore: number; // 전체 평균 점수
  qualitative: {
    emotionalDepth: { ko: string; en: string }; // 정성 평가: 감정 깊이
    vividness: { ko: string; en: string }; // 묘사의 생생함
    metaphors: { ko: string; en: string }; // 비유/은유 활용
    literaryValue: { ko: string; en: string }; // 문학적 가치
  };
  quantitative: QuantScores; // 정량 평가 결과
  meta: {
    model: string; // 사용한 모델명
    chunks: number; // 청크 개수
    chunkSize: number; // 청크 최대 길이
    overlap: number; // 청크 겹침 크기
    requestIds: string[]; // OpenAI API 요청 ID들 (디버깅용)
    tokens?: {
      input: number;
      output: number;
      total: number;
    };
  };
}

// 평가 함수 입력값
export interface EvaluateParams {
  source: string; // 원작 (한글)
  translated: string; // 번역문 (영어)
  authorIntention?: string; // 작가 의도/번역 방향 (선택)
  model?: string; // OpenAI 모델명 (기본 gpt-4.1)
  maxCharsPerChunk?: number; // 청크 최대 길이 (기본 8000자)
  overlap?: number; // 청크 간 겹침 길이 (기본 400자)
  strict?: boolean; // 검증 여부 (기본 true)
}

// ----------------------------- OpenAI Client -----------------------------

const DEFAULT_LITERARY_MODEL = process.env.LITERARY_QA_MODEL || "gpt-4o-mini";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 시스템 프롬프트: 모델에게 "이 구조로 JSON만 반환하라"고 강제
const SYSTEM_PROMPT = `
You are a professional literary translator and editor.
Evaluate a single English translation of a Korean literary source, producing BOTH numeric scores (0–100) and concise literary commentary in BOTH Korean and English.

Follow this fixed output schema (JSON). Do NOT include any text outside JSON.
Schema:
{
  "overallScore": number,
  "qualitative": {
    "emotionalDepth": { "ko": string, "en": string },
    "vividness": { "ko": string, "en": string },
    "metaphors": { "ko": string, "en": string },
    "literaryValue": { "ko": string, "en": string }
  },
  "quantitative": {
    "Fidelity":         { "score": number, "commentary": { "ko": string, "en": string } },
    "Fluency":          { "score": number, "commentary": { "ko": string, "en": string } },
    "Literary Style":   { "score": number, "commentary": { "ko": string, "en": string } },
    "Cultural Resonance": { "score": number, "commentary": { "ko": string, "en": string } },
    "Creative Autonomy":  { "score": number, "commentary": { "ko": string, "en": string } }
  }
}

Apply these shared evaluation guidelines consistently:
${SHARED_TRANSLATION_GUIDELINES}

Additional instructions:
- Korean commentary should be natural and professional Korean.
- English commentary should be natural and professional English.
- Keep both versions concise but informative and ensure they convey the same meaning.
`;

// ----------------------------- 청크 분할 함수 -----------------------------

// 긴 텍스트를 일정 크기 단위로 나누는 함수 (문단 우선 → 문장 분리)
// overlap 옵션으로 앞 청크 꼬리를 붙여 맥락 보존
function splitIntoChunks(text: string, target = 8000, overlap = 400): string[] {
  if (text.length <= target) return [text];
  const paras = text.split(/\n{2,}/g); // 문단 단위로 먼저 분리
  const chunks: string[] = [];
  let buf: string[] = [];
  let curLen = 0;

  const flush = () => {
    if (!buf.length) return;
    chunks.push(buf.join("\n\n"));
    buf = [];
    curLen = 0;
  };

  for (const p of paras) {
    const plus = (curLen ? 2 : 0) + p.length;
    if (curLen + plus <= target) {
      buf.push(p);
      curLen += plus;
    } else if (p.length > target) {
      // 문단이 너무 길면 문장 단위로 다시 분리
      const sens = p.split(/(?<=[.!?])\s+/);
      let sbuf: string[] = [];
      let slen = 0;
      const sflush = () => {
        if (!sbuf.length) return;
        chunks.push(sbuf.join(" "));
        sbuf = [];
        slen = 0;
      };
      for (const s of sens) {
        const add = (slen ? 1 : 0) + s.length;
        if (slen + add <= target) {
          sbuf.push(s);
          slen += add;
        } else {
          sflush();
          sbuf.push(s);
          slen = s.length;
        }
      }
      sflush();
      flush();
    } else {
      flush();
      buf.push(p);
      curLen = p.length;
    }
  }
  flush();

  // overlap 처리: 이전 청크의 꼬리를 붙여 맥락 유지
  if (overlap > 0 && chunks.length > 1) {
    const withOverlap: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      if (i === 0) withOverlap.push(chunks[i]);
      else withOverlap.push(chunks[i - 1].slice(-overlap) + chunks[i]);
    }
    return withOverlap;
  }
  return chunks;
}

// 번역문은 원작과 길이가 다르므로, 개수 맞춰 비율로 자르기
function proportionalSliceByCount(text: string, count: number): string[] {
  if (count <= 1) return [text];
  const len = text.length;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const s = Math.floor((i / count) * len);
    const e = Math.floor(((i + 1) / count) * len);
    out.push(text.slice(s, e));
  }
  return out;
}

// ----------------------------- OpenAI 호출 -----------------------------

// 기대하는 JSON 구조 정의 (Zod로 파싱 검증)
const EvalJson = z.object({
  overallScore: z.number(),
  qualitative: z.object({
    emotionalDepth: z.object({ ko: z.string(), en: z.string() }),
    vividness: z.object({ ko: z.string(), en: z.string() }),
    metaphors: z.object({ ko: z.string(), en: z.string() }),
    literaryValue: z.object({ ko: z.string(), en: z.string() }),
  }),
  quantitative: z.object({
    Fidelity: z.object({
      score: z.number(),
      commentary: z.object({ ko: z.string(), en: z.string() }),
    }),
    Fluency: z.object({
      score: z.number(),
      commentary: z.object({ ko: z.string(), en: z.string() }),
    }),
    "Literary Style": z.object({
      score: z.number(),
      commentary: z.object({ ko: z.string(), en: z.string() }),
    }),
    "Cultural Resonance": z.object({
      score: z.number(),
      commentary: z.object({ ko: z.string(), en: z.string() }),
    }),
    "Creative Autonomy": z.object({
      score: z.number(),
      commentary: z.object({ ko: z.string(), en: z.string() }),
    }),
  }),
});

const evalResponseJsonSchema = {
  name: "quality_evaluation_response",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["overallScore", "qualitative", "quantitative"],
    properties: {
      overallScore: { type: "number" },
      qualitative: {
        type: "object",
        additionalProperties: false,
        required: [
          "emotionalDepth",
          "vividness",
          "metaphors",
          "literaryValue",
        ],
        properties: {
          emotionalDepth: {
            type: "object",
            additionalProperties: false,
            required: ["ko", "en"],
            properties: {
              ko: { type: "string" },
              en: { type: "string" },
            },
          },
          vividness: {
            type: "object",
            additionalProperties: false,
            required: ["ko", "en"],
            properties: {
              ko: { type: "string" },
              en: { type: "string" },
            },
          },
          metaphors: {
            type: "object",
            additionalProperties: false,
            required: ["ko", "en"],
            properties: {
              ko: { type: "string" },
              en: { type: "string" },
            },
          },
          literaryValue: {
            type: "object",
            additionalProperties: false,
            required: ["ko", "en"],
            properties: {
              ko: { type: "string" },
              en: { type: "string" },
            },
          },
        },
      },
      quantitative: {
        type: "object",
        additionalProperties: false,
        required: [
          "Fidelity",
          "Fluency",
          "Literary Style",
          "Cultural Resonance",
          "Creative Autonomy",
        ],
        properties: {
          Fidelity: {
            type: "object",
            additionalProperties: false,
            required: ["score", "commentary"],
            properties: {
              score: { type: "number" },
              commentary: {
                type: "object",
                additionalProperties: false,
                required: ["ko", "en"],
                properties: {
                  ko: { type: "string" },
                  en: { type: "string" },
                },
              },
            },
          },
          Fluency: {
            type: "object",
            additionalProperties: false,
            required: ["score", "commentary"],
            properties: {
              score: { type: "number" },
              commentary: {
                type: "object",
                additionalProperties: false,
                required: ["ko", "en"],
                properties: {
                  ko: { type: "string" },
                  en: { type: "string" },
                },
              },
            },
          },
          "Literary Style": {
            type: "object",
            additionalProperties: false,
            required: ["score", "commentary"],
            properties: {
              score: { type: "number" },
              commentary: {
                type: "object",
                additionalProperties: false,
                required: ["ko", "en"],
                properties: {
                  ko: { type: "string" },
                  en: { type: "string" },
                },
              },
            },
          },
          "Cultural Resonance": {
            type: "object",
            additionalProperties: false,
            required: ["score", "commentary"],
            properties: {
              score: { type: "number" },
              commentary: {
                type: "object",
                additionalProperties: false,
                required: ["ko", "en"],
                properties: {
                  ko: { type: "string" },
                  en: { type: "string" },
                },
              },
            },
          },
          "Creative Autonomy": {
            type: "object",
            additionalProperties: false,
            required: ["score", "commentary"],
            properties: {
              score: { type: "number" },
              commentary: {
                type: "object",
                additionalProperties: false,
                required: ["ko", "en"],
                properties: {
                  ko: { type: "string" },
                  en: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  },
};

// 단일 청크 평가 요청
async function evalChunk(params: {
  model: string;
  sourceChunk: string;
  translatedChunk: string;
  authorIntention?: string;
  attempt?: number;
}): Promise<{
  data: z.infer<typeof EvalJson>;
  requestId?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}> {
  const {
    model,
    sourceChunk,
    translatedChunk,
    authorIntention,
    attempt = 1,
  } = params;

  const userBlock = [
    `SOURCE_TEXT (Korean):\n${sourceChunk}`,
    `\nTRANSLATED_TEXT (English):\n${translatedChunk}`,
    authorIntention ? `\nAUTHOR_INTENTION:\n${authorIntention}` : "",
    `\nReturn ONLY valid JSON as per schema.`,
  ].join("\n");

  try {
    console.log(
      `🤖 [QualityAgent] Calling OpenAI with model: ${model}, attempt: ${attempt}`,
    );
    console.log(
      `📝 [QualityAgent] Source chunk length: ${sourceChunk.length}, Translated chunk length: ${translatedChunk.length}`,
    );

    const resp = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userBlock },
      ],
      temperature: 0.1,
      max_tokens: 3000,
      response_format: {
        type: "json_schema",
        json_schema: evalResponseJsonSchema,
      },
    });

    const requestId = resp.id;
    const text = resp.choices[0]?.message?.content || "";

    console.log(
      `📤 [QualityAgent] OpenAI response received, request ID: ${requestId}`,
    );
    console.log(`📄 [QualityAgent] Raw response length: ${text?.length || 0}`);

    try {
      const jsonData = JSON.parse(text);
      console.log(`✅ [QualityAgent] JSON parsing successful`);

      const parsed = EvalJson.parse(jsonData); // JSON 파싱 & 검증
      console.log(
        `✅ [QualityAgent] Zod validation successful, overall score: ${parsed.overallScore}`,
      );

      return { data: parsed, requestId, usage: resp.usage };
    } catch (parseError) {
      console.error(`❌ [QualityAgent] JSON/Zod parsing failed:`, parseError);
      console.error(
        `❌ [QualityAgent] Raw response text:`,
        text?.substring(0, 500),
      );
      throw parseError;
    }
  } catch (err) {
    console.error(
      `💥 [QualityAgent] OpenAI call failed (attempt ${attempt}):`,
      err,
    );

    // 실패 시 최대 3회 재시도 (지수 백오프)
    if (attempt < 3) {
      console.log(`🔄 [QualityAgent] Retrying in ${600 * attempt}ms...`);
      await new Promise((r) => setTimeout(r, 600 * attempt));
      return evalChunk({ ...params, attempt: attempt + 1 });
    }
    console.error(`❌ [QualityAgent] All retry attempts failed`);
    throw err;
  }
}

// ----------------------------- 집계 함수 -----------------------------

const avg = (ns: number[]) =>
  Math.round(ns.reduce((a, b) => a + b, 0) / Math.max(1, ns.length));

const merge = (parts: string[], limit = 4) =>
  parts
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, limit)
    .join(" ");

// Merge function for bilingual content
// Accept inputs where ko/en may be optional coming from partial chunk results
const mergeBilingual = (
  parts: Array<{ ko?: string; en?: string }>,
  limit = 4,
) => ({
  ko: merge(
    parts.map((p: any) => p.ko || ""),
    limit,
  ),
  en: merge(
    parts.map((p: any) => p.en || ""),
    limit,
  ),
});

// ----------------------------- 최종 평가 함수 -----------------------------

export async function evaluateQuality({
  source,
  translated,
  authorIntention,
  model = DEFAULT_LITERARY_MODEL,
  maxCharsPerChunk = 8000,
  overlap = 400,
  strict = true,
}: EvaluateParams): Promise<FinalEvaluation> {
  console.log("🎯 [QualityAgent] Starting quality evaluation");
  console.log(`📊 [QualityAgent] Parameters:`, {
    sourceLength: source.length,
    translatedLength: translated.length,
    hasAuthorIntention: !!authorIntention,
    model,
    maxCharsPerChunk,
    overlap,
  });

  if (!process.env.OPENAI_API_KEY) {
    console.error("❌ [QualityAgent] OPENAI_API_KEY is not set");
    throw new Error("OPENAI_API_KEY is not set.");
  }

  // 1) 원작과 번역문을 청크 단위로 분할
  console.log("✂️ [QualityAgent] Splitting text into chunks...");
  const sChunks = splitIntoChunks(source, maxCharsPerChunk, overlap);
  const tChunks = proportionalSliceByCount(translated, sChunks.length);

  console.log(`📑 [QualityAgent] Created ${sChunks.length} chunks`);

  // 2) 각 청크별로 평가 요청
  console.log("🔄 [QualityAgent] Starting chunk evaluation...");
  const per: z.infer<typeof EvalJson>[] = [];
  const reqIds: string[] = [];
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  for (let i = 0; i < sChunks.length; i++) {
    const { data, requestId, usage } = await evalChunk({
      model,
      sourceChunk: sChunks[i],
      translatedChunk: tChunks[i] ?? "",
      authorIntention,
    });
    per.push(data);
    if (requestId) reqIds.push(requestId);
    if (usage) {
      totalPromptTokens += usage.prompt_tokens ?? 0;
      totalCompletionTokens += usage.completion_tokens ?? 0;
    }
  }

  // 3) 정량 점수 평균 + 정성 코멘트 합성
  const keys: QuantKeys[] = [
    "Fidelity",
    "Fluency",
    "Literary Style",
    "Cultural Resonance",
    "Creative Autonomy",
  ];

  const quantitative = Object.fromEntries(
    keys.map((k) => {
      const scores = per.map((p) => p.quantitative[k].score);
      const coms = per.map((p) => p.quantitative[k].commentary);
      return [k, { score: avg(scores), commentary: mergeBilingual(coms, 2) }];
    }),
  ) as QuantScores;

  const overallScore = avg(keys.map((k) => quantitative[k].score));

  const qualitative = {
    emotionalDepth: mergeBilingual(
      per.map((p) => p.qualitative.emotionalDepth),
    ),
    vividness: mergeBilingual(per.map((p) => p.qualitative.vividness)),
    metaphors: mergeBilingual(per.map((p) => p.qualitative.metaphors)),
    literaryValue: mergeBilingual(per.map((p) => p.qualitative.literaryValue)),
  };

  // 4) 최종 결과 반환
  console.log("🎉 [QualityAgent] Quality evaluation completed successfully");
  console.log(`📊 [QualityAgent] Final result:`, {
    overallScore,
    chunksProcessed: sChunks.length,
    requestIds: reqIds.length,
  });

  return {
    overallScore,
    qualitative,
    quantitative,
    meta: {
      model,
      chunks: sChunks.length,
      chunkSize: maxCharsPerChunk,
      overlap,
      requestIds: reqIds,
      tokens: {
        input: totalPromptTokens,
        output: totalCompletionTokens,
        total: totalPromptTokens + totalCompletionTokens,
      },
    },
  };
}
