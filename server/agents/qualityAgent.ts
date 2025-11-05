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
import { runResponsesWithRetry } from "../services/openaiResponses";
import { SHARED_TRANSLATION_GUIDELINES } from "./prompts/sharedGuidelines";
import { buildAlignedPairSet } from "./quality/alignedPairs";
import { buildQualityChunks } from "./quality/chunking";

const DEFAULT_CHUNK_SIZE = Number(process.env.LITERARY_QA_CHUNK_SIZE) || 3200;
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
      truncated?: boolean;
      jsonRepairApplied?: boolean;
    }>;
    config?: {
      maxOutputTokens: number;
      maxOutputTokensCap: number;
      concurrency: number;
    };
    truncatedChunks?: number;
    totalAttempts?: number;
    jsonRepairAppliedChunks?: number;
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
  projectId?: string | null;
  jobId?: string | null;
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
      pairCount?: number;
      overlapPairCount?: number;
      sourceTokens?: number;
      translatedTokens?: number;
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
      pairCount?: number;
      overlapPairCount?: number;
      sourceTokens?: number;
      translatedTokens?: number;
      truncated?: boolean;
      jsonRepairApplied?: boolean;
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

export const DEFAULT_LITERARY_MODEL =
  process.env.LITERARY_QA_MODEL || "gpt-5-mini";

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
  Number(process.env.LITERARY_QA_MAX_OUTPUT_TOKENS) || 12000;
const QA_MAX_OUTPUT_TOKENS_CAP = Math.max(
  QA_MAX_OUTPUT_TOKENS,
  Number(process.env.LITERARY_QA_MAX_OUTPUT_TOKENS_CAP) || 24000,
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
  Boolean(
    value && typeof value.ko === "string" && typeof value.en === "string",
  );

const isQuantEntryComplete = (
  value?: {
    score?: number;
    commentary?: { ko?: string; en?: string };
  } | null,
) =>
  typeof value?.score === "number" && isCommentaryComplete(value?.commentary);

const ensureCommentary = (
  value: { ko?: string; en?: string } | undefined,
  fallback: { ko: string; en: string },
) => ({
  ko: value?.ko && value.ko.trim().length ? value.ko.trim() : fallback.ko,
  en: value?.en && value.en.trim().length ? value.en.trim() : fallback.en,
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
        required: ["emotionalDepth", "vividness", "metaphors", "literaryValue"],
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
  onRetry?(info: {
    index: number;
    from: number;
    to: number;
  }): void | Promise<void>;
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
const DELAY_BASE_MS = 600;

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
  truncated: boolean;
  jsonRepairApplied: boolean;
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

  let currentMaxTokens = maxOutputTokens;
  let totalAttempts = 0;
  let truncatedEncountered = false;
  let lastPreview: string | null = null;
  let lastRequestId: string | undefined;
  let lastUsage:
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      }
    | undefined;

  for (
    let outerAttempt = attempt;
    outerAttempt <= MAX_CHUNK_ATTEMPTS;
    outerAttempt += 1
  ) {
    let previousTokens = currentMaxTokens;
    let runResult;

    try {
      runResult = await runResponsesWithRetry({
        client,
        initialMaxOutputTokens: currentMaxTokens,
        maxOutputTokensCap,
        maxAttempts: Math.min(3, MAX_CHUNK_ATTEMPTS - outerAttempt + 1),
        minOutputTokens: 200,
        onAttempt: ({ attemptIndex, maxOutputTokens }) => {
          if (attemptIndex > 0) {
            void callbacks.onRetry?.({
              index: chunkIndex,
              from: previousTokens,
              to: maxOutputTokens,
            });
          }
          previousTokens = maxOutputTokens;
        },
        buildRequest: ({ maxOutputTokens }) =>
          client.responses.create({
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
          }),
      });
    } catch (error) {
      if (isFatalParamErr(error)) {
        throw error;
      }
      if (outerAttempt >= MAX_CHUNK_ATTEMPTS) {
        console.error(
          `❌ [QualityAgent] OpenAI call failed for chunk ${chunkIndex + 1}`,
          error,
        );
        throw error;
      }
      console.warn(
        `⚠️ [QualityAgent] OpenAI call failed for chunk ${chunkIndex + 1}, retrying (outer attempt ${outerAttempt + 1})`,
        error,
      );
      await new Promise((resolve) =>
        setTimeout(resolve, DELAY_BASE_MS * outerAttempt),
      );
      continue;
    }

    totalAttempts += runResult.attempts;
    currentMaxTokens = runResult.maxOutputTokens;
    truncatedEncountered = truncatedEncountered || runResult.truncated;

    const {
      parsedJson,
      text,
      requestId,
      usage,
      repairApplied,
    } = safeExtractOpenAIResponse(runResult.response);

    lastRequestId = requestId ?? runResult.response.id ?? undefined;
    lastUsage = usage;
    lastPreview = text
      ? `${text.slice(0, 280)}${text.length > 280 ? "…" : ""}`
      : null;

    if (!parsedJson || typeof parsedJson !== "object") {
      await callbacks.onPartial?.({
        index: chunkIndex,
        attempt: outerAttempt,
        missingFields: [],
        requestId: lastRequestId,
        preview: lastPreview,
        fallbackApplied: false,
      });

      if (outerAttempt >= MAX_CHUNK_ATTEMPTS) {
        const err = new Error("quality_missing_json");
        (err as any).metadata = {
          chunkIndex,
          attempt: outerAttempt,
          requestId: lastRequestId,
          hasText: Boolean(text),
          textPreview: lastPreview,
        };
        throw err;
      }

      const nextTokens = Math.min(
        maxOutputTokensCap,
        Math.round(currentMaxTokens * 1.4),
      );
      if (nextTokens > currentMaxTokens) {
        await callbacks.onRetry?.({
          index: chunkIndex,
          from: currentMaxTokens,
          to: nextTokens,
        });
        currentMaxTokens = nextTokens;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, DELAY_BASE_MS * outerAttempt),
      );
      continue;
    }

    const partialResult = EvalJsonPartial.safeParse(parsedJson);
    if (!partialResult.success) {
      await callbacks.onPartial?.({
        index: chunkIndex,
        attempt: outerAttempt,
        missingFields: [],
        requestId: lastRequestId,
        preview: lastPreview,
        fallbackApplied: false,
      });

      if (outerAttempt >= MAX_CHUNK_ATTEMPTS) {
        const err = new Error("quality_invalid_json");
        (err as any).metadata = {
          chunkIndex,
          attempt: outerAttempt,
          requestId: lastRequestId,
          issues: partialResult.error.issues,
        };
        throw err;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, DELAY_BASE_MS * outerAttempt),
      );
      continue;
    }

    const partial = partialResult.data;
    const missingFields = collectMissingFields(partial);

    if (!missingFields.length) {
      const parsed = EvalJson.parse(partial);
      return {
        data: parsed,
        requestId: lastRequestId,
        usage: lastUsage,
        maxOutputTokensUsed: currentMaxTokens,
        fallbackApplied: false,
        missingFields: [],
        attemptsUsed: totalAttempts,
        partialPreview: null,
        truncated: truncatedEncountered,
        jsonRepairApplied: Boolean(repairApplied),
      };
    }

    await callbacks.onPartial?.({
      index: chunkIndex,
      attempt: outerAttempt,
      missingFields,
      requestId: lastRequestId,
      preview: lastPreview,
      fallbackApplied: false,
    });

    const fallbackReady =
      outerAttempt >= MAX_CHUNK_ATTEMPTS ||
      currentMaxTokens >= maxOutputTokensCap;

    if (fallbackReady) {
      const completed = buildFallbackEvaluation(partial);
      await callbacks.onPartial?.({
        index: chunkIndex,
        attempt: outerAttempt,
        missingFields,
        requestId: lastRequestId,
        preview: lastPreview,
        fallbackApplied: true,
      });

      return {
        data: completed,
        requestId: lastRequestId,
        usage: lastUsage,
        maxOutputTokensUsed: currentMaxTokens,
        fallbackApplied: true,
        missingFields,
        attemptsUsed: totalAttempts,
        partialPreview: lastPreview ?? null,
        truncated: truncatedEncountered,
        jsonRepairApplied: Boolean(repairApplied),
      };
    }

    const nextTokens = Math.min(
      maxOutputTokensCap,
      Math.round(currentMaxTokens * 1.4),
    );
    if (nextTokens > currentMaxTokens) {
      await callbacks.onRetry?.({
        index: chunkIndex,
        from: currentMaxTokens,
        to: nextTokens,
      });
      currentMaxTokens = nextTokens;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, DELAY_BASE_MS * outerAttempt),
    );
  }

  throw new Error("quality_chunk_failed");
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
  sourceTokens: number;
  translatedTokens: number;
  pairCount: number;
  overlapPairCount: number;
  startPairIndex: number;
  endPairIndex: number;
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
  truncated: boolean;
  jsonRepairApplied: boolean;
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
    projectId,
    jobId,
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

  const chunkSize = maxCharsPerChunk ?? DEFAULT_CHUNK_SIZE;
  const chunkOverlap = overlap ?? DEFAULT_CHUNK_OVERLAP;
  const tokenBudget = Math.max(200, Math.floor(chunkSize / 3.5));
  const overlapTokenBudget = Math.max(0, Math.floor(chunkOverlap / 3.5));

  const pairSet = await buildAlignedPairSet({
    source,
    translated,
    projectId,
    jobId,
  });

  if (!pairSet.pairs.length) {
    throw new Error("Unable to derive aligned content for quality evaluation");
  }

  if (pairSet.source === "segment") {
    console.log(
      `[QualityAgent] Using finalized translation segments for alignment (pairs=${pairSet.pairs.length}, file=${pairSet.metadata?.translationFileId ?? "n/a"})`,
    );
  } else if (pairSet.source === "draft") {
    console.log(
      `[QualityAgent] Using translation draft segments for alignment (pairs=${pairSet.pairs.length}, runOrder=${pairSet.metadata?.runOrder ?? "n/a"})`,
    );
  } else {
    console.log(
      `[QualityAgent] Falling back to sentence alignment (pairs=${pairSet.pairs.length})`,
    );
  }

  console.log("✂️ [QualityAgent] Splitting text into chunks...");
  const rawChunks = buildQualityChunks(pairSet.pairs, {
    tokenBudget,
    overlapTokenBudget,
  });

  if (!rawChunks.length) {
    throw new Error("Failed to build chunk descriptors for quality evaluation");
  }

  console.log(
    `📑 [QualityAgent] Created ${rawChunks.length} chunks (tokenBudget≈${tokenBudget}, overlapTokens≈${overlapTokenBudget})`,
  );

  rawChunks.forEach((chunk) => {
    console.log(
      `[QualityAgent] Chunk ${chunk.index + 1}: pairs=${chunk.pairCount}, overlap=${chunk.overlapPairCount}, tokens(KO=${chunk.sourceTokens}, EN=${chunk.translatedTokens}), lengths(KO=${chunk.sourceLength}, EN=${chunk.translatedLength})`,
    );
  });

  const chunkDescriptors = rawChunks.map((chunk) => ({
    index: chunk.index,
    sourceChunk: chunk.sourceText,
    translatedChunk: chunk.translatedText,
    sourceLength: chunk.sourceLength,
    translatedLength: chunk.translatedLength,
    sourceTokens: chunk.sourceTokens,
    translatedTokens: chunk.translatedTokens,
    pairCount: chunk.pairCount,
    overlapPairCount: chunk.overlapPairCount,
    startPairIndex: chunk.startPairIndex,
    endPairIndex: chunk.endPairIndex,
    initialMaxOutputTokens: QA_MAX_OUTPUT_TOKENS,
  }));

  const totalChunks = chunkDescriptors.length;
  const concurrency = Math.max(
    1,
    Math.min(totalChunks, options.concurrency ?? DEFAULT_QUALITY_CONCURRENCY),
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
        pairCount: descriptor.pairCount,
        overlapPairCount: descriptor.overlapPairCount,
        sourceTokens: descriptor.sourceTokens,
        translatedTokens: descriptor.translatedTokens,
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
          truncated,
          jsonRepairApplied,
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
          sourceTokens:
            descriptor.sourceTokens ?? estimateTokens(descriptor.sourceChunk),
          translatedTokens:
            descriptor.translatedTokens ??
            estimateTokens(descriptor.translatedChunk),
          pairCount: descriptor.pairCount ?? 0,
          overlapPairCount: descriptor.overlapPairCount ?? 0,
          startPairIndex: descriptor.startPairIndex ?? 0,
          endPairIndex: descriptor.endPairIndex ?? descriptor.index,
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
          truncated,
          jsonRepairApplied: Boolean(jsonRepairApplied),
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
          pairCount: descriptor.pairCount,
          overlapPairCount: descriptor.overlapPairCount,
          sourceTokens: descriptor.sourceTokens,
          translatedTokens: descriptor.translatedTokens,
          truncated,
          jsonRepairApplied: Boolean(jsonRepairApplied),
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
          message: error instanceof Error ? error.message : String(error ?? ""),
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

  const quantitativeEntries = keys.map((key) => ({
    key,
    score: weightedAverage(
      completedRecords.map((record) => ({
        value: record.data.quantitative[key].score,
        weight: Math.max(record.sourceTokens, record.translatedTokens),
      })),
    ),
    commentary: mergeBilingual(
      completedRecords.map(
        (record) => record.data.quantitative[key].commentary,
      ),
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
    sourceTokens: record.sourceTokens,
    translatedTokens: record.translatedTokens,
    pairCount: record.pairCount,
    overlapPairCount: record.overlapPairCount,
    startPairIndex: record.startPairIndex,
    endPairIndex: record.endPairIndex,
    durationMs: record.durationMs,
    requestId: record.requestId,
    maxOutputTokensUsed: record.maxOutputTokensUsed,
    usage: record.usage,
    attempts: record.attempts,
    fallbackApplied: record.fallbackApplied,
    missingFields: record.missingFields,
    preview: record.partialPreview ?? null,
    truncated: record.truncated,
    jsonRepairApplied: record.jsonRepairApplied,
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
      truncatedChunks: completedRecords.filter((record) => record.truncated)
        .length,
      totalAttempts: completedRecords.reduce(
        (sum, record) => sum + record.attempts,
        0,
      ),
      jsonRepairAppliedChunks: completedRecords.filter(
        (record) => record.jsonRepairApplied,
      ).length,
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
