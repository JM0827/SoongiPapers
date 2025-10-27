// server/agents/qualityAgent.ts
// OpenAI API를 활용해 번역 품질(단일 번역 평가)을 수행하는 모듈
// Fastify 라우트에서 호출해 사용합니다.
											
														  
																 
																
																	 
																				
								 
																		
																				

import OpenAI from "openai";
import { z } from "zod";

import {
  estimateTokens,
  isFatalParamErr,
  safeExtractOpenAIResponse,
} from "../services/llm";
import { SHARED_TRANSLATION_GUIDELINES } from "./prompts/sharedGuidelines";

const DEFAULT_CHUNK_SIZE =
  Number(process.env.LITERARY_QA_CHUNK_SIZE) || 3200;
const DEFAULT_CHUNK_OVERLAP =
  Number(process.env.LITERARY_QA_CHUNK_OVERLAP) || 200;
const DEFAULT_QUALITY_CONCURRENCY = Math.max(
  1,
  Number(process.env.LITERARY_QA_CONCURRENCY) || 2,
);
									 
												 

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
    chunkStats?: Array<{
      index: number;
      sourceLength: number;
      translatedLength: number;
      durationMs: number;
      requestId?: string;
      maxOutputTokensUsed: number;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
      attempts?: number;
      fallbackApplied?: boolean;
      missingFields?: string[];
      preview?: string | null;
    }>;
    config?: {
      maxOutputTokens: number;
      maxOutputTokensCap: number;
      concurrency: number;
    };
  };
}

																		  

// 평가 함수 입력값
export interface EvaluateParams {
  source: string; // 원작 (한글)
  translated: string; // 번역문 (영어)
  authorIntention?: string; // 작가 의도/번역 방향 (선택)
  model?: string; // OpenAI 모델명 (기본 gpt-4.1)
  maxCharsPerChunk?: number; // 청크 최대 길이 (기본 3200자)
  overlap?: number; // 청크 간 겹침 길이 (기본 200자)
  strict?: boolean; // 검증 여부 (기본 true)
}

export type QualityEvaluationEvent =
  | {
      type: "start";
      totalChunks: number;
      model: string;
      params: {
        chunkSize: number;
        overlap: number;
        maxOutputTokens: number;
        maxOutputTokensCap: number;
        concurrency: number;
      };
    }
  | {
      type: "chunk-start";
      index: number;
      total: number;
      sourceLength: number;
      translatedLength: number;
      maxOutputTokens: number;
    }
  | {
      type: "chunk-retry";
      index: number;
      from: number;
      to: number;
    }
  | {
      type: "chunk-complete";
      index: number;
      total: number;
      durationMs: number;
      requestId?: string;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
      maxOutputTokensUsed: number;
      result: z.infer<typeof EvalJson>;
      fallbackApplied?: boolean;
      missingFields?: string[];
      attempts?: number;
      preview?: string | null;
    }
  | {
      type: "chunk-partial";
      index: number;
      total: number;
      attempt: number;
      missingFields: string[];
      requestId?: string;
      preview?: string | null;
      fallbackApplied: boolean;
    }
  | {
      type: "chunk-error";
      index: number;
      message: string;
      error?: unknown;
    }
  | {
      type: "progress";
      completed: number;
      total: number;
    }
  | {
      type: "complete";
      result: FinalEvaluation;
    };

export interface QualityEvaluationListeners {
  onEvent?(event: QualityEvaluationEvent): void | Promise<void>;
}

export interface QualityEvaluationOptions {
  listeners?: QualityEvaluationListeners;
  concurrency?: number;
}

// ----------------------------- OpenAI Client -----------------------------
																   

export const DEFAULT_LITERARY_MODEL = process.env.LITERARY_QA_MODEL || "gpt-5";

const parseVerbosity = (value?: string | null) => {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return ["low", "medium", "high"].includes(normalized)
    ? (normalized as "low" | "medium" | "high")
    : undefined;
};

const parseReasoningEffort = (value?: string | null) => {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return ["minimal", "low", "medium", "high"].includes(normalized)
    ? (normalized as "minimal" | "low" | "medium" | "high")
    : undefined;
};

const QA_VERBOSITY = parseVerbosity(process.env.LITERARY_QA_MODEL_VERBOSITY);
const QA_REASONING_EFFORT = parseReasoningEffort(
  process.env.LITERARY_QA_MODEL_REASONING_EFFORT,
);
const QA_MAX_OUTPUT_TOKENS =
  Number(process.env.LITERARY_QA_MAX_OUTPUT_TOKENS) || 6000;
const QA_MAX_OUTPUT_TOKENS_CAP = Math.max(
  QA_MAX_OUTPUT_TOKENS,
  Number(process.env.LITERARY_QA_MAX_OUTPUT_TOKENS_CAP) || 8192,
);

const isGpt5Model = (model: string) => /^gpt-5/i.test(model);

const CONTEXT_TOKEN_LIMIT = 32768;
const CONTEXT_BUFFER_TOKENS = 2000;

const MAX_CHUNK_ATTEMPTS = 3;

const FALLBACK_QUAL_MESSAGE = {
  ko: "⚠️ 이 청크 응답이 일부 누락되어 추정 코멘트를 사용했습니다.",
  en: "⚠️ Some sections were missing, so fallback commentary was inserted.",
};

const FALLBACK_QUANT_MESSAGE: Record<QuantKeys, { ko: string; en: string }> = {
  Fidelity: {
    ko: "⚠️ 충실성 점수가 누락되어 추정값을 적용했습니다.",
    en: "⚠️ Fidelity score was missing; applied a fallback value.",
  },
  Fluency: {
    ko: "⚠️ 유창성 점수가 누락되어 추정값을 적용했습니다.",
    en: "⚠️ Fluency score was missing; applied a fallback value.",
  },
  "Literary Style": {
    ko: "⚠️ 문체 점수가 누락되어 추정값을 적용했습니다.",
    en: "⚠️ Literary style score was missing; applied a fallback value.",
  },
  "Cultural Resonance": {
    ko: "⚠️ 문화적 공명 점수가 누락되어 추정값을 적용했습니다.",
    en: "⚠️ Cultural resonance score was missing; applied a fallback value.",
  },
  "Creative Autonomy": {
    ko: "⚠️ 창의적 자율성 점수가 누락되어 추정값을 적용했습니다.",
    en: "⚠️ Creative autonomy score was missing; applied a fallback value.",
  },
};

const clampScore = (value: number) =>
  Math.max(0, Math.min(100, Math.round(value)));

const isCommentaryComplete = (value?: { ko?: string; en?: string } | null) =>
  Boolean(value && typeof value.ko === "string" && typeof value.en === "string");

const isQuantEntryComplete = (value?: {
  score?: number;
  commentary?: { ko?: string; en?: string };
} | null) =>
  typeof value?.score === "number" && isCommentaryComplete(value?.commentary);

const ensureCommentary = (
  value: { ko?: string; en?: string } | undefined,
  fallback: { ko: string; en: string },
) => ({
  ko:
    value?.ko && value.ko.trim().length ? value.ko.trim() : fallback.ko,
  en:
    value?.en && value.en.trim().length ? value.en.trim() : fallback.en,
});

const collectMissingFields = (partial: PartialEval): string[] => {
  const missing: string[] = [];
  if (typeof partial.overallScore !== "number") {
    missing.push("overallScore");
  }
  const qualitative = partial.qualitative ?? {};
  if (!isCommentaryComplete(qualitative.emotionalDepth)) {
    missing.push("qualitative.emotionalDepth");
  }
  if (!isCommentaryComplete(qualitative.vividness)) {
    missing.push("qualitative.vividness");
  }
  if (!isCommentaryComplete(qualitative.metaphors)) {
    missing.push("qualitative.metaphors");
  }
  if (!isCommentaryComplete(qualitative.literaryValue)) {
    missing.push("qualitative.literaryValue");
  }

  const quantitative = partial.quantitative ?? {};
  const keys: QuantKeys[] = [
    "Fidelity",
    "Fluency",
    "Literary Style",
    "Cultural Resonance",
    "Creative Autonomy",
  ];
  for (const key of keys) {
    if (!isQuantEntryComplete(quantitative[key])) {
      missing.push(`quantitative.${key}`);
    }
  }

  return missing;
};

const buildFallbackEvaluation = (
  partial: PartialEval,
): z.infer<typeof EvalJson> => {
  const fallbackScore = clampScore(
    typeof partial.overallScore === "number" ? partial.overallScore : 58,
  );

  const qualitativeSource = partial.qualitative ?? {};
  const qualitative = {
    emotionalDepth: ensureCommentary(
      qualitativeSource.emotionalDepth,
      FALLBACK_QUAL_MESSAGE,
    ),
    vividness: ensureCommentary(
      qualitativeSource.vividness,
      FALLBACK_QUAL_MESSAGE,
    ),
    metaphors: ensureCommentary(
      qualitativeSource.metaphors,
      FALLBACK_QUAL_MESSAGE,
    ),
    literaryValue: ensureCommentary(
      qualitativeSource.literaryValue,
      FALLBACK_QUAL_MESSAGE,
    ),
  } as z.infer<typeof EvalJson>["qualitative"];

  const quantitativeSource = partial.quantitative ?? {};
  const quantitativeEntries = {
    Fidelity: {
      score: clampScore(
        typeof quantitativeSource.Fidelity?.score === "number"
          ? quantitativeSource.Fidelity.score
          : fallbackScore,
      ),
      commentary: ensureCommentary(
        quantitativeSource.Fidelity?.commentary,
        FALLBACK_QUANT_MESSAGE.Fidelity,
      ),
    },
    Fluency: {
      score: clampScore(
        typeof quantitativeSource.Fluency?.score === "number"
          ? quantitativeSource.Fluency.score
          : fallbackScore,
      ),
      commentary: ensureCommentary(
        quantitativeSource.Fluency?.commentary,
        FALLBACK_QUANT_MESSAGE.Fluency,
      ),
    },
    "Literary Style": {
      score: clampScore(
        typeof quantitativeSource["Literary Style"]?.score === "number"
          ? quantitativeSource["Literary Style"].score
          : fallbackScore,
      ),
      commentary: ensureCommentary(
        quantitativeSource["Literary Style"]?.commentary,
        FALLBACK_QUANT_MESSAGE["Literary Style"],
      ),
    },
    "Cultural Resonance": {
      score: clampScore(
        typeof quantitativeSource["Cultural Resonance"]?.score === "number"
          ? quantitativeSource["Cultural Resonance"].score
          : fallbackScore,
      ),
      commentary: ensureCommentary(
        quantitativeSource["Cultural Resonance"]?.commentary,
        FALLBACK_QUANT_MESSAGE["Cultural Resonance"],
      ),
    },
    "Creative Autonomy": {
      score: clampScore(
        typeof quantitativeSource["Creative Autonomy"]?.score === "number"
          ? quantitativeSource["Creative Autonomy"].score
          : fallbackScore,
      ),
      commentary: ensureCommentary(
        quantitativeSource["Creative Autonomy"]?.commentary,
        FALLBACK_QUANT_MESSAGE["Creative Autonomy"],
      ),
    },
  } as QuantScores;

  return {
    overallScore: fallbackScore,
    qualitative,
    quantitative: quantitativeEntries,
  };
};

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
OUTPUT CONTRACT:
- Return ONLY JSON; no prose.
- Each commentary ≤ 35 words.
`;

// ----------------------------- 청크 분할 함수 -----------------------------
											 
																							  
				
										
																			
								   
				  
   

// 긴 텍스트를 일정 크기 단위로 나누는 함수 (문단 우선 → 문장 분리)
// overlap 옵션으로 앞 청크 꼬리를 붙여 맥락 보존
function splitIntoChunks(
  text: string,
  target = DEFAULT_CHUNK_SIZE,
  overlap = DEFAULT_CHUNK_OVERLAP,
): string[] {
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
const CommentarySchema = z.object({
  ko: z.string(),
  en: z.string(),
});

const CommentaryPartialSchema = z.object({
  ko: z.string().optional(),
  en: z.string().optional(),
});

const QuantitativeEntryPartialSchema = z.object({
  score: z.number().optional(),
  commentary: CommentaryPartialSchema.optional(),
});

const EvalJson = z.object({
  overallScore: z.number(),
  qualitative: z.object({
    emotionalDepth: CommentarySchema,
    vividness: CommentarySchema,
    metaphors: CommentarySchema,
    literaryValue: CommentarySchema,
  }),
  quantitative: z.object({
    Fidelity: z.object({
      score: z.number(),
      commentary: CommentarySchema,
    }),
    Fluency: z.object({
      score: z.number(),
      commentary: CommentarySchema,
    }),
    "Literary Style": z.object({
      score: z.number(),
      commentary: CommentarySchema,
    }),
    "Cultural Resonance": z.object({
      score: z.number(),
      commentary: CommentarySchema,
    }),
    "Creative Autonomy": z.object({
      score: z.number(),
      commentary: CommentarySchema,
    }),
  }),
});

const EvalJsonPartial = z.object({
  overallScore: z.number().optional(),
  qualitative: z
    .object({
      emotionalDepth: CommentaryPartialSchema.optional(),
      vividness: CommentaryPartialSchema.optional(),
      metaphors: CommentaryPartialSchema.optional(),
      literaryValue: CommentaryPartialSchema.optional(),
    })
    .partial()
    .optional(),
  quantitative: z
    .object({
      Fidelity: QuantitativeEntryPartialSchema.optional(),
      Fluency: QuantitativeEntryPartialSchema.optional(),
      "Literary Style": QuantitativeEntryPartialSchema.optional(),
      "Cultural Resonance": QuantitativeEntryPartialSchema.optional(),
      "Creative Autonomy": QuantitativeEntryPartialSchema.optional(),
    })
    .partial()
    .optional(),
});

type PartialEval = z.infer<typeof EvalJsonPartial>;

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

interface EvalChunkCallbacks {
  onRetry?(info: { index: number; from: number; to: number }): void | Promise<void>;
  onPartial?(info: {
    index: number;
    attempt: number;
    missingFields: string[];
    requestId?: string;
    preview?: string | null;
    fallbackApplied: boolean;
  }): void | Promise<void>;
}

// 단일 청크 평가 요청
async function evalChunk(
  params: {
    model: string;
    sourceChunk: string;
    translatedChunk: string;
    authorIntention?: string;
    attempt?: number;
    maxOutputTokens: number;
    maxOutputTokensCap: number;
    chunkIndex: number;
  },
  callbacks: EvalChunkCallbacks = {},
): Promise<{
  data: z.infer<typeof EvalJson>;
  requestId?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  maxOutputTokensUsed: number;
  fallbackApplied?: boolean;
  missingFields?: string[];
  attemptsUsed: number;
  partialPreview?: string | null;
}> {
  const {
    model,
    sourceChunk,
    translatedChunk,
    authorIntention,
    attempt = 1,
    maxOutputTokens,
    maxOutputTokensCap,
    chunkIndex,
  } = params;

  const attemptReminder =
    attempt > 1
      ? "\nIMPORTANT: Include every field (overallScore, all qualitative entries, all quantitative scores with bilingual commentary) even if the translation is partial."
      : "";

  const userBlock = [
    `SOURCE_TEXT (Korean):\n${sourceChunk}`,
    `\nTRANSLATED_TEXT (English):\n${translatedChunk}`,
    authorIntention ? `\nAUTHOR_INTENTION:\n${authorIntention}` : "",
    `\nReturn ONLY valid JSON as per schema.${attemptReminder}`,
  ].join("\n");

  const estimatedTokens =
    estimateTokens(SYSTEM_PROMPT) +
    estimateTokens(userBlock) +
    estimateTokens(sourceChunk) +
    estimateTokens(translatedChunk) +
    CONTEXT_BUFFER_TOKENS;

  if (estimatedTokens > CONTEXT_TOKEN_LIMIT) {
    throw new Error("Chunk too large for model context");
  }

  try {
    console.log(
      `🤖 [QualityAgent] Calling OpenAI with model: ${model}, attempt: ${attempt}`,
    );
    console.log(
      `📝 [QualityAgent] Source chunk length: ${sourceChunk.length}, Translated chunk length: ${translatedChunk.length}`,
    );

    const textConfig: {
      format: {
        type: "json_schema";
        name: string;
        schema: Record<string, unknown>;
        strict: true;
      };
      verbosity?: "low" | "medium" | "high";
    } = {
      format: {
        type: "json_schema",
        name: evalResponseJsonSchema.name,
        schema: evalResponseJsonSchema.schema,
        strict: true,
      },
    };

    if (isGpt5Model(model) && QA_VERBOSITY) {
      textConfig.verbosity = QA_VERBOSITY;
    }

    const reasoningConfig =
      isGpt5Model(model) && QA_REASONING_EFFORT
        ? { effort: QA_REASONING_EFFORT }
        : undefined;

    const resp = await client.responses.create({
      model,
      max_output_tokens: maxOutputTokens,
      text: textConfig,
      reasoning: reasoningConfig,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: SYSTEM_PROMPT }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: userBlock }],
        },
      ],
    });

    const { parsedJson, text, requestId, usage } =
      safeExtractOpenAIResponse(resp);

    console.log(
      `📤 [QualityAgent] OpenAI response received, request ID: ${requestId}`,
    );
    console.log(
      `📄 [QualityAgent] Raw response length: ${text?.length || 0} (chunk ${chunkIndex + 1})`,
    );

    if (!parsedJson || typeof parsedJson !== "object") {
      const preview = text
        ? `${text.slice(0, 280)}${text.length > 280 ? "…" : ""}`
        : null;
      console.warn(
        `⚠️ [QualityAgent] Parsed JSON missing for chunk ${chunkIndex + 1} (attempt ${attempt})`,
        preview ? { preview } : undefined,
      );
      const err = new Error("quality_missing_json");
      (err as any).metadata = {
        chunkIndex,
        attempt,
        requestId,
        hasText: Boolean(text),
        textPreview: preview,
      };
      throw err;
    }

    const partialResult = EvalJsonPartial.safeParse(parsedJson);
    if (!partialResult.success) {
      console.warn(
        `⚠️ [QualityAgent] JSON structure invalid for chunk ${chunkIndex + 1} (attempt ${attempt})`,
        { issues: partialResult.error.issues },
      );
      const err = new Error("quality_invalid_json");
      (err as any).metadata = {
        chunkIndex,
        attempt,
        requestId,
        issues: partialResult.error.issues,
      };
      throw err;
    }

    const partial = partialResult.data;
    const missingFields = collectMissingFields(partial);
    const preview = text
      ? `${text.slice(0, 280)}${text.length > 280 ? "…" : ""}`
      : null;

    if (!missingFields.length) {
      console.log(`✅ [QualityAgent] JSON parsing successful`);
      const parsed = EvalJson.parse(partial);
      console.log(
        `✅ [QualityAgent] Zod validation successful, overall score: ${parsed.overallScore}`,
      );
      return {
        data: parsed,
        requestId,
        usage,
        maxOutputTokensUsed: maxOutputTokens,
        fallbackApplied: false,
        missingFields,
        attemptsUsed: attempt,
        partialPreview: null,
      };
    }

    await callbacks.onPartial?.({
      index: chunkIndex,
      attempt,
      missingFields,
      requestId,
      preview,
      fallbackApplied: false,
    });

    console.warn(
      `⚠️ [QualityAgent] Chunk ${chunkIndex + 1} missing fields: ${missingFields.join(", ")}`,
    );

    const fallbackReady =
      attempt >= MAX_CHUNK_ATTEMPTS || maxOutputTokens >= maxOutputTokensCap;

    if (fallbackReady) {
      console.warn(
        `⚠️ [QualityAgent] Applying fallback completion for chunk ${chunkIndex + 1}`,
      );
      const completed = buildFallbackEvaluation(partial);
      await callbacks.onPartial?.({
        index: chunkIndex,
        attempt,
        missingFields,
        requestId,
        preview,
        fallbackApplied: true,
      });
      return {
        data: completed,
        requestId,
        usage,
        maxOutputTokensUsed: maxOutputTokens,
        fallbackApplied: true,
        missingFields,
        attemptsUsed: attempt,
        partialPreview: preview,
      };
    }

    const err = new Error("quality_missing_json");
    (err as any).metadata = {
      chunkIndex,
      attempt,
      requestId,
      hasText: Boolean(text),
      textPreview: preview,
      missingFields,
      partial,
    };
    throw err;
  } catch (err) {
    const metadata = (err as any)?.metadata ?? {};
    const incompleteReason = metadata.reason;
    const isIncompleteDueToTokens =
      (err as any)?.code === "openai_response_incomplete" &&
      incompleteReason === "max_output_tokens";
    const isMissingJson = err instanceof Error && err.message === "quality_missing_json";
    const isInvalidJson = err instanceof Error && err.message === "quality_invalid_json";

    if (isIncompleteDueToTokens && maxOutputTokens < maxOutputTokensCap) {
      const nextTokens = Math.min(
        maxOutputTokensCap,
        Math.round(maxOutputTokens * 1.5),
      );
      if (nextTokens > maxOutputTokens) {
        console.log(
          `[QualityAgent] Chunk ${chunkIndex + 1} exceeded max_output_tokens (${maxOutputTokens}); retrying with ${nextTokens}`,
        );
        await callbacks.onRetry?.({
          index: chunkIndex,
          from: maxOutputTokens,
          to: nextTokens,
        });
        return evalChunk({
          ...params,
          maxOutputTokens: nextTokens,
          attempt: attempt + 1,
        }, callbacks);
      }
    }

    if (isMissingJson && attempt < MAX_CHUNK_ATTEMPTS) {
      const missingFields: string[] = metadata.missingFields ?? [];
      const nextTokensCandidate = Math.min(
        maxOutputTokensCap,
        Math.round(maxOutputTokens * 1.4),
      );
      const nextTokens = Math.max(nextTokensCandidate, maxOutputTokens);
      console.log(
        `[QualityAgent] Chunk ${chunkIndex + 1} missing fields (${missingFields.join(", ")}); retrying with ${nextTokens}`,
      );
      await callbacks.onRetry?.({
        index: chunkIndex,
        from: maxOutputTokens,
        to: nextTokens,
      });
      if (nextTokens > maxOutputTokens) {
        return evalChunk({
          ...params,
          maxOutputTokens: nextTokens,
          attempt: attempt + 1,
        }, callbacks);
      }
      console.log(
        `[QualityAgent] Chunk ${chunkIndex + 1} retrying with unchanged token budget`,
      );
      await new Promise((r) => setTimeout(r, 600 * attempt));
      return evalChunk({ ...params, attempt: attempt + 1 }, callbacks);
    }

    if (isInvalidJson && attempt < MAX_CHUNK_ATTEMPTS) {
      console.warn(
        `[QualityAgent] Invalid JSON payload for chunk ${chunkIndex + 1}; retrying (attempt ${attempt + 1})`,
      );
      await new Promise((r) => setTimeout(r, 600 * attempt));
      return evalChunk({ ...params, attempt: attempt + 1 }, callbacks);
    }

    console.error(
      `💥 [QualityAgent] OpenAI call failed (attempt ${attempt}):`,
      err,
    );

    if (isFatalParamErr(err)) {
      throw err;
    }

    if (attempt < MAX_CHUNK_ATTEMPTS) {
      console.log(`🔄 [QualityAgent] Retrying in ${600 * attempt}ms...`);
      await new Promise((r) => setTimeout(r, 600 * attempt));
      return evalChunk({ ...params, attempt: attempt + 1 }, callbacks);
    }
    console.error(`❌ [QualityAgent] All retry attempts failed`);
    throw err;
  }
}

// ----------------------------- 집계 함수 -----------------------------

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

interface ChunkEvaluationRecord {
  index: number;
  sourceLength: number;
  translatedLength: number;
  data: z.infer<typeof EvalJson>;
  requestId?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  durationMs: number;
  maxOutputTokensUsed: number;
  initialMaxOutputTokens: number;
  attempts: number;
  fallbackApplied: boolean;
  missingFields: string[];
  partialPreview?: string | null;
}

const roundScore = (value: number) => Math.round(value);

const weightedAverage = (items: Array<{ value: number; weight: number }>) => {
  const totalWeight = items.reduce((acc, item) => acc + item.weight, 0);
  if (!totalWeight) return 0;
  return roundScore(
    items.reduce((acc, item) => acc + item.value * item.weight, 0) /
      totalWeight,
  );
};

export async function callQualityModel(
  {
    source,
    translated,
    authorIntention,
    model = DEFAULT_LITERARY_MODEL,
    maxCharsPerChunk = DEFAULT_CHUNK_SIZE,
    overlap = DEFAULT_CHUNK_OVERLAP,
    strict = true,
  }: EvaluateParams,
  options: QualityEvaluationOptions = {},
): Promise<FinalEvaluation> {
  console.log("🎯 [QualityAgent] Starting quality evaluation");
  console.log(`📊 [QualityAgent] Parameters:`, {
    sourceLength: source.length,
    translatedLength: translated.length,
    hasAuthorIntention: !!authorIntention,
    model,
    maxCharsPerChunk,
    overlap,
    maxOutputTokens: QA_MAX_OUTPUT_TOKENS,
  });
  console.log(
    `[QualityAgent] Using OpenAI model ${model} (DEFAULT_LITERARY_MODEL=${DEFAULT_LITERARY_MODEL}, verbosity=${QA_VERBOSITY ?? "default"}, reasoning=${QA_REASONING_EFFORT ?? "default"})`,
  );
	  
				
												
					
											
		   
								
						  
													   
										  
												  
			  
		   
					
			

  if (!process.env.OPENAI_API_KEY) {
    console.error("❌ [QualityAgent] OPENAI_API_KEY is not set");
    throw new Error("OPENAI_API_KEY is not set.");
  }

  // 1) 원작과 번역문을 청크 단위로 분할
  console.log("✂️ [QualityAgent] Splitting text into chunks...");
  const chunkSize = maxCharsPerChunk ?? DEFAULT_CHUNK_SIZE;
  const chunkOverlap = overlap ?? DEFAULT_CHUNK_OVERLAP;

  const sChunks = splitIntoChunks(source, chunkSize, chunkOverlap);
  const tChunks = proportionalSliceByCount(translated, sChunks.length);

  console.log(`📑 [QualityAgent] Created ${sChunks.length} chunks`);

  const chunkDescriptors = sChunks.map((sourceChunk, index) => ({
    index,
    sourceChunk,
    translatedChunk: tChunks[index] ?? "",
    sourceLength: sourceChunk.length,
    translatedLength: (tChunks[index] ?? "").length,
    initialMaxOutputTokens: QA_MAX_OUTPUT_TOKENS,
  }));

  const totalChunks = chunkDescriptors.length;
  const concurrency = Math.max(
    1,
    Math.min(
      totalChunks,
      options.concurrency ?? DEFAULT_QUALITY_CONCURRENCY,
    ),
  );

  await options.listeners?.onEvent?.({
    type: "start",
    totalChunks,
    model,
    params: {
      chunkSize,
      overlap: chunkOverlap,
      maxOutputTokens: QA_MAX_OUTPUT_TOKENS,
      maxOutputTokensCap: QA_MAX_OUTPUT_TOKENS_CAP,
      concurrency,
    },
  });

  console.log("🔄 [QualityAgent] Starting chunk evaluation...");

  const chunkRecords: ChunkEvaluationRecord[] = new Array(totalChunks);
  let nextIndex = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let completedChunks = 0;

  const worker = async () => {
    while (true) {
      const workIndex = nextIndex++;
      if (workIndex >= totalChunks) break;
      const descriptor = chunkDescriptors[workIndex];

      await options.listeners?.onEvent?.({
        type: "chunk-start",
        index: descriptor.index,
        total: totalChunks,
        sourceLength: descriptor.sourceLength,
        translatedLength: descriptor.translatedLength,
        maxOutputTokens: descriptor.initialMaxOutputTokens,
      });

      const startedAt = Date.now();
      try {
        const {
          data,
          requestId,
          usage,
          maxOutputTokensUsed,
          fallbackApplied,
          missingFields,
          attemptsUsed,
          partialPreview,
        } = await evalChunk(
          {
            model,
            sourceChunk: descriptor.sourceChunk,
            translatedChunk: descriptor.translatedChunk,
            authorIntention,
            maxOutputTokens: descriptor.initialMaxOutputTokens,
            maxOutputTokensCap: QA_MAX_OUTPUT_TOKENS_CAP,
            chunkIndex: descriptor.index,
          },
          {
            onRetry: async ({ from, to }) => {
              await options.listeners?.onEvent?.({
                type: "chunk-retry",
                index: descriptor.index,
                from,
                to,
              });
            },
            onPartial: async ({
              attempt,
              missingFields: partialMissing,
              requestId: partialRequestId,
              preview,
              fallbackApplied: partialFallback,
            }) => {
              await options.listeners?.onEvent?.({
                type: "chunk-partial",
                index: descriptor.index,
                total: totalChunks,
                attempt,
                missingFields: partialMissing,
                requestId: partialRequestId,
                preview: preview ?? null,
                fallbackApplied: partialFallback,
              });
            },
          },
        );

        const durationMs = Date.now() - startedAt;

        chunkRecords[descriptor.index] = {
          index: descriptor.index,
          sourceLength: descriptor.sourceLength,
          translatedLength: descriptor.translatedLength,
          data,
          requestId,
          usage,
          durationMs,
          maxOutputTokensUsed,
          initialMaxOutputTokens: descriptor.initialMaxOutputTokens,
          attempts: attemptsUsed,
          fallbackApplied: Boolean(fallbackApplied),
          missingFields: missingFields ?? [],
          partialPreview: partialPreview ?? null,
        };

        if (usage) {
          totalPromptTokens += usage.prompt_tokens ?? 0;
          totalCompletionTokens += usage.completion_tokens ?? 0;
        }

        completedChunks += 1;

        await options.listeners?.onEvent?.({
          type: "chunk-complete",
          index: descriptor.index,
          total: totalChunks,
          durationMs,
          requestId,
          usage,
          maxOutputTokensUsed,
          result: data,
          fallbackApplied: Boolean(fallbackApplied),
          missingFields: missingFields ?? [],
          attempts: attemptsUsed,
          preview: partialPreview ?? null,
        });

        await options.listeners?.onEvent?.({
          type: "progress",
          completed: completedChunks,
          total: totalChunks,
        });
      } catch (error) {
        await options.listeners?.onEvent?.({
          type: "chunk-error",
          index: descriptor.index,
          message:
            error instanceof Error ? error.message : String(error ?? ""),
          error,
        });
        throw error;
      }
    }
  };

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  const completedRecords = chunkRecords.filter(
    (record): record is ChunkEvaluationRecord => Boolean(record),
  );

  // 3) 정량 점수 평균 + 정성 코멘트 합성
  const keys: QuantKeys[] = [
    "Fidelity",
    "Fluency",
    "Literary Style",
    "Cultural Resonance",
    "Creative Autonomy",
  ];

  const weightedScores = completedRecords.map((record) => ({
    weight: record.sourceLength,
    overall: record.data.overallScore,
  }));

  const quantitativeEntries = keys.map((key) => ({
    key,
    score: weightedAverage(
      completedRecords.map((record) => ({
        value: record.data.quantitative[key].score,
        weight: record.sourceLength,
      })),
    ),
    commentary: mergeBilingual(
      completedRecords.map((record) => record.data.quantitative[key].commentary),
      2,
    ),
  }));

  const quantitative = Object.fromEntries(
    quantitativeEntries.map((entry) => [
      entry.key,
      { score: entry.score, commentary: entry.commentary },
    ]),
  ) as QuantScores;

  const overallScore = weightedAverage(
    completedRecords.map((record) => ({
      value: record.data.overallScore,
      weight: record.sourceLength,
    })),
  );

  const qualitative = {
    emotionalDepth: mergeBilingual(
      completedRecords.map((record) => record.data.qualitative.emotionalDepth),
    ),
    vividness: mergeBilingual(
      completedRecords.map((record) => record.data.qualitative.vividness),
    ),
    metaphors: mergeBilingual(
      completedRecords.map((record) => record.data.qualitative.metaphors),
    ),
    literaryValue: mergeBilingual(
      completedRecords.map((record) => record.data.qualitative.literaryValue),
    ),
  };

  const reqIds = completedRecords
    .map((record) => record.requestId)
    .filter((id): id is string => Boolean(id));

  const chunkStats = completedRecords.map((record) => ({
    index: record.index,
    sourceLength: record.sourceLength,
    translatedLength: record.translatedLength,
    durationMs: record.durationMs,
    requestId: record.requestId,
    maxOutputTokensUsed: record.maxOutputTokensUsed,
    usage: record.usage,
     attempts: record.attempts,
     fallbackApplied: record.fallbackApplied,
     missingFields: record.missingFields,
     preview: record.partialPreview ?? null,
  }));

  const result: FinalEvaluation = {
    overallScore,
    qualitative,
    quantitative,
    meta: {
      model,
      chunks: totalChunks,
      chunkSize,
      overlap: chunkOverlap,
      requestIds: reqIds,
      tokens: {
        input: totalPromptTokens,
        output: totalCompletionTokens,
        total: totalPromptTokens + totalCompletionTokens,
      },
      chunkStats,
      config: {
        maxOutputTokens: QA_MAX_OUTPUT_TOKENS,
        maxOutputTokensCap: QA_MAX_OUTPUT_TOKENS_CAP,
        concurrency,
      },
    },
  };

  console.log("🎉 [QualityAgent] Quality evaluation completed successfully");
  console.log(`📊 [QualityAgent] Final result:`, {
    overallScore,
    chunksProcessed: totalChunks,
    requestIds: reqIds.length,
  });

  await options.listeners?.onEvent?.({ type: "complete", result });

  return result;
}

export async function evaluateQuality(
  params: EvaluateParams,
  options?: QualityEvaluationOptions,
): Promise<FinalEvaluation> {
  console.log(
    "[QualityAgent] evaluateQuality() delegating to callQualityModel",
  );
  return callQualityModel(params, options);
}
