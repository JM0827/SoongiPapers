import { createHash } from "crypto";
import { OpenAI } from "openai";

import type { TranslationNotes } from "../../models/DocumentProfile";
import {
  resolveLocale as resolveOutputLocale,
  type UILocale,
} from "../../services/localeService";
import { safeExtractOpenAIResponse } from "../../services/llm";

type ResponseVerbosity = "low" | "medium" | "high";
type ResponseReasoningEffort = "minimal" | "low" | "medium" | "high";

const WORDS_PER_MINUTE = 220;
const DEFAULT_MODEL =
  process.env.PROFILE_AGENT_MODEL?.trim() || "gpt-5-mini";
const FALLBACK_MODEL =
  process.env.PROFILE_AGENT_VALIDATION_MODEL?.trim() || "gpt-5-mini";
const DEFAULT_VERBOSITY = normalizeVerbosity(
  process.env.PROFILE_AGENT_VERBOSITY,
);
const DEFAULT_REASONING_EFFORT = normalizeReasoningEffort(
  process.env.PROFILE_AGENT_REASONING_EFFORT,
);
const DEFAULT_MAX_OUTPUT_TOKENS = normalizePositiveInteger(
  process.env.PROFILE_AGENT_MAX_OUTPUT_TOKENS,
  1600,
);
const MAX_OUTPUT_TOKENS_CAP = normalizePositiveInteger(
  process.env.PROFILE_AGENT_MAX_OUTPUT_TOKENS_CAP,
  4800,
);
const CONTEXT_CHAR_LIMIT = normalizePositiveInteger(
  process.env.PROFILE_AGENT_CONTEXT_CHAR_LIMIT,
  20_000,
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

interface RawProfileResponse {
  summary?: unknown;
  intention?: unknown;
  readerPoints?: unknown;
  translationNotes?: unknown;
}

const profileResponseSchema = {
  name: "document_profile_analysis",
  schema: {
    type: "object",
    required: ["summary", "intention", "readerPoints", "translationNotes"],
    additionalProperties: false,
    properties: {
      summary: { type: "string", maxLength: 800 },
      intention: { type: "string", maxLength: 300 },
      readerPoints: {
        type: "array",
        minItems: 0,
        maxItems: 6,
        items: { type: "string", maxLength: 160 },
        default: [],
      },
      translationNotes: {
        type: "object",
        additionalProperties: false,
        properties: {
          characters: {
            type: "array",
            default: [],
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                targetName: { type: ["string", "null"], default: null },
                age: { type: ["string", "null"], default: null },
                gender: { type: ["string", "null"], default: null },
                traits: {
                  type: "array",
                  default: [],
                  items: { type: "string" },
                },
              },
              required: ["name", "targetName", "age", "gender", "traits"],
            },
          },
          namedEntities: {
            type: "array",
            default: [],
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                targetName: { type: ["string", "null"], default: null },
                frequency: { type: ["number", "null"], default: 0 },
              },
              required: ["name", "targetName", "frequency"],
            },
          },
          locations: {
            type: "array",
            default: [],
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                targetName: { type: ["string", "null"], default: null },
                frequency: { type: ["number", "null"], default: 0 },
              },
              required: ["name", "targetName", "frequency"],
            },
          },
          measurementUnits: {
            type: "array",
            default: [],
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                source: { type: "string" },
                target: { type: ["string", "null"], default: null },
              },
              required: ["source", "target"],
            },
          },
          linguisticFeatures: {
            type: "array",
            default: [],
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                source: { type: "string" },
                target: { type: ["string", "null"], default: null },
              },
              required: ["source", "target"],
            },
          },
          timePeriod: { type: ["string", "null"], default: null },
        },
        required: [
          "characters",
          "namedEntities",
          "locations",
          "measurementUnits",
          "linguisticFeatures",
          "timePeriod",
        ],
      },
    },
  },
};

function normalizeVerbosity(value: string | undefined | null): ResponseVerbosity {
  if (!value) return "medium";
  const normalized = value.trim().toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high") {
    return normalized;
  }
  return "medium";
}

function normalizeReasoningEffort(
  value: string | undefined | null,
): ResponseReasoningEffort {
  if (!value) return "medium";
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high"
  ) {
    return normalized;
  }
  return "medium";
}

function normalizePositiveInteger(
  value: string | undefined | null,
  fallback: number,
): number {
  const parsed = Number.parseInt((value ?? "").trim(), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

const VERBOSITY_ORDER: ResponseVerbosity[] = ["low", "medium", "high"];
const EFFORT_ORDER: ResponseReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
];

function escalateVerbosity(current: ResponseVerbosity): ResponseVerbosity {
  const index = VERBOSITY_ORDER.indexOf(current);
  return VERBOSITY_ORDER[Math.min(VERBOSITY_ORDER.length - 1, index + 1)];
}

function escalateReasoningEffort(
  current: ResponseReasoningEffort,
): ResponseReasoningEffort {
  const index = EFFORT_ORDER.indexOf(current);
  return EFFORT_ORDER[Math.min(EFFORT_ORDER.length - 1, index + 1)];
}

export type ProfileVariant = "origin" | "translation";

export interface ProfileAgentInput {
  projectId: string;
  text: string;
  variant: ProfileVariant;
  language?: string | null;
  targetLanguage?: string | null;
  snippetLabel?: string;
  summaryLocale?: string | null;
}

export interface ProfileAgentOutput {
  summary: {
    story: string;
    intention: string;
    readerPoints: string[];
  };
  metrics: {
    wordCount: number;
    charCount: number;
    paragraphCount: number;
    readingTimeMinutes: number;
    readingTimeLabel: string;
  };
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  sourceHash: string;
  sourcePreview: string;
  translationNotes: TranslationNotes | null;
  meta: {
    verbosity: ResponseVerbosity;
    reasoningEffort: ResponseReasoningEffort;
    maxOutputTokens: number;
    chunkCount: number;
    retryCount: number;
    truncated: boolean;
  };
}

function countWords(text: string) {
  const normalized = text
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[-•·]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return 0;
  return normalized.split(" ").filter(Boolean).length;
}

function countParagraphs(text: string) {
  return text
    .split(/\n{2,}/g)
    .map((segment) => segment.trim())
    .filter(Boolean).length;
}

function formatReadingTimeLabel(words: number) {
  if (words <= 0) return "읽을 수 있는 내용이 없습니다.";
  const totalMinutes = words / WORDS_PER_MINUTE;
  const totalSeconds = Math.round(totalMinutes * 60);
  if (totalSeconds < 60) {
    const rounded = Math.max(30, Math.round(totalSeconds / 10) * 10);
    return `약 ${rounded}초`;
  }
  const roundedMinutes = Math.max(1, Math.round(totalMinutes));
  if (roundedMinutes < 60) {
    return `약 ${roundedMinutes}분`;
  }
  const hours = Math.floor(roundedMinutes / 60);
  const minutes = roundedMinutes % 60;
  if (minutes === 0) {
    return `약 ${hours}시간`;
  }
  return `약 ${hours}시간 ${minutes}분`;
}

function truncateWords(input: string, limit: number) {
  if (!input) return "";
  const words = input.split(/\s+/).filter(Boolean);
  if (words.length <= limit) return input.trim();
  return `${words.slice(0, limit).join(" ")}…`;
}

function normalizeReaderPoints(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean)
    .slice(0, 4)
    .map((entry) => truncateWords(entry, 40));
}

const toNullableString = (value: unknown): string | null => {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  return null;
};

const normalizeStringArray = (value: unknown, limit = 20): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean)
    .slice(0, limit)
    .map((entry) => truncateWords(entry, 20));
};

function parseEntityList(
  value: unknown,
): Array<{ name: string; targetName: string | null; frequency: number }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const name = toNullableString((entry as Record<string, unknown>).name) ?? "";
      if (!name) return null;
      const targetName =
        toNullableString(
          (entry as Record<string, unknown>).targetName ??
            (entry as Record<string, unknown>).target,
        ) ?? null;
      const rawFrequency = (entry as Record<string, unknown>).frequency;
      const frequency = Number.isFinite(rawFrequency)
        ? Number(rawFrequency)
        : Number((entry as Record<string, unknown>).count ?? 0);
      return {
        name: truncateWords(name, 12),
        targetName: targetName ? truncateWords(targetName, 12) : null,
        frequency: Number.isFinite(frequency) ? Math.max(0, frequency) : 0,
      };
    })
    .filter(
      (entry): entry is { name: string; targetName: string | null; frequency: number } =>
        Boolean(entry),
    )
    .slice(0, 20);
}

function parseCharacters(value: unknown): TranslationNotes["characters"] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const source = entry as Record<string, unknown>;
      const name = toNullableString(source.name) ?? "";
      if (!name) return null;
      const targetName = toNullableString(
        source.targetName ?? source.target ?? source.translation,
      );
      const age = toNullableString(source.age);
      const gender = toNullableString(source.gender);
      const traits = normalizeStringArray(source.traits, 5);
      return {
        name: truncateWords(name, 12),
        targetName: targetName ? truncateWords(targetName, 12) : null,
        age,
        gender,
        traits,
      };
    })
    .filter((entry): entry is TranslationNotes["characters"][number] => Boolean(entry))
    .slice(0, 20);
}

function parseBilingualList(
  value: unknown,
  limit = 20,
): TranslationNotes["measurementUnits"] {
  if (!value) return [];
  const entries = Array.isArray(value) ? value : [value];
  return entries
    .map((entry) => {
      if (typeof entry === "string") {
        const source = entry.trim();
        if (!source) return null;
        return { source: truncateWords(source, 12), target: null };
      }
      if (entry && typeof entry === "object") {
        const sourceValue =
          toNullableString((entry as Record<string, unknown>).source) ??
          toNullableString((entry as Record<string, unknown>).name);
        if (!sourceValue) return null;
        const targetValue =
          toNullableString((entry as Record<string, unknown>).target) ??
          toNullableString((entry as Record<string, unknown>).targetName);
        return {
          source: truncateWords(sourceValue, 12),
          target: targetValue ? truncateWords(targetValue, 12) : null,
        };
      }
      return null;
    })
    .filter((entry): entry is TranslationNotes["measurementUnits"][number] =>
      Boolean(entry),
    )
    .slice(0, limit);
}

function parseTranslationNotes(value: unknown): TranslationNotes | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const characters = parseCharacters(raw.characters);
  const namedEntities = parseEntityList(raw.namedEntities ?? raw.entities);
  const locations = parseEntityList(raw.locations);
  const measurementUnits = parseBilingualList(raw.measurementUnits ?? raw.units);
  const linguisticFeatures = parseBilingualList(
    raw.linguisticFeatures ?? raw.slang ?? raw.phrases,
  );
  const timePeriod = toNullableString(raw.timePeriod ?? raw.era ?? raw.timeline);

  if (
    !characters.length &&
    !namedEntities.length &&
    !locations.length &&
    !measurementUnits.length &&
    !linguisticFeatures.length &&
    !timePeriod
  ) {
    return null;
  }

  return {
    characters,
    namedEntities,
    timePeriod,
    locations,
    measurementUnits,
    linguisticFeatures,
  };
}

export async function analyzeDocumentProfile(
  input: ProfileAgentInput,
): Promise<ProfileAgentOutput> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is not configured for profile analysis agent",
    );
  }

  const text = input.text?.trim();
  if (!text) {
    throw new Error("No text provided for profile analysis");
  }

  const charCount = Array.from(text).length;
  const wordCount = countWords(text);
  const paragraphCount = countParagraphs(text);
  const readingTimeMinutes = Number((wordCount / WORDS_PER_MINUTE).toFixed(2));
  const readingTimeLabel = formatReadingTimeLabel(wordCount);

  const truncated =
    text.length > CONTEXT_CHAR_LIMIT
      ? `${text.slice(0, CONTEXT_CHAR_LIMIT)}\n\n[... 생략됨 ...]`
      : text;
  const wasTruncated = truncated.length !== text.length;
  const sourceHash = createHash("sha256").update(text).digest("hex");
  const sourcePreview = text.slice(0, 600);

  const variantLabel = input.variant === "origin" ? "original" : "translated";
  const languageHint = input.language
    ? `Expected language: ${input.language}.`
    : "";
  const targetLanguageHint = input.targetLanguage
    ? `Target language for translations: ${input.targetLanguage}.`
    : "Target language for translations: English.";

  const outputLocale: UILocale = resolveOutputLocale(input.summaryLocale ?? null);
  const localeInstruction =
    outputLocale === "ko"
      ? "Write the summary, intention, and readerPoints in Korean using natural Korean sentences."
      : "Write the summary, intention, and readerPoints in English.";

const systemPrompt = `You are a seasoned Korean literature critic and translation analyst.
You study manuscripts and produce structured insights that downstream translation agents consume.
Keep the voice professional, fact-driven, and under 250 words overall.`;

  const userPrompt = `Project: ${input.projectId}
Variant: ${variantLabel}
${languageHint}
${targetLanguageHint}
Tasks:
1. Provide a vivid but concise story summary (<= 120 words).
2. State the author's narrative intention or purpose (<= 50 words).
3. List 2-4 reader takeaways or emotional touchpoints (each <= 35 words).
4. Extract Translation Notes as JSON with bilingual fields:
   - characters: [{ name (source), targetName (translation), age?, gender?, traits[] }]
   - namedEntities: top 20 [{ name, targetName, frequency }]
   - locations: top 20 [{ name, targetName, frequency }]
   - timePeriod: string | null
   - measurementUnits: up to 20 [{ source, target }]
   - linguisticFeatures: up to 20 [{ source, target }]
   When a translated form is uncertain, set targetName/target to null.

${localeInstruction}
Respond strictly as JSON with keys: summary (string), intention (string), readerPoints (string[]), translationNotes (object).

Text to analyze:
"""
${truncated}
"""`;
  let dynamicMaxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS;
  let lastRequestMaxTokens = Math.min(
    dynamicMaxOutputTokens,
    MAX_OUTPUT_TOKENS_CAP,
  );
  const attempts: Array<{
    model: string;
    verbosity: ResponseVerbosity;
    effort: ResponseReasoningEffort;
  }> = [
    {
      model: DEFAULT_MODEL,
      verbosity: DEFAULT_VERBOSITY,
      effort: DEFAULT_REASONING_EFFORT,
    },
    {
      model: DEFAULT_MODEL,
      verbosity: "low",
      effort: "minimal",
    },
  ];

  if (FALLBACK_MODEL && FALLBACK_MODEL !== DEFAULT_MODEL) {
    attempts.push({
      model: FALLBACK_MODEL,
      verbosity: "low",
      effort: "minimal",
    });
  }

  let parsedPayload: RawProfileResponse | null = null;
  let responseModel = DEFAULT_MODEL;
  let usage = { inputTokens: 0, outputTokens: 0 };
  let selectedAttemptIndex = -1;
  let lastError: unknown = null;

  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    try {
      const requestMaxTokens = Math.min(
        dynamicMaxOutputTokens,
        MAX_OUTPUT_TOKENS_CAP,
      );

      const response = await openai.responses.create({
        model: attempt.model,
        max_output_tokens: requestMaxTokens,
        text: {
          format: {
            type: "json_schema",
            name: profileResponseSchema.name,
            schema: profileResponseSchema.schema,
            strict: true,
          },
          verbosity: attempt.verbosity,
        },
        reasoning: { effort: attempt.effort },
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: systemPrompt }],
          },
          {
            role: "user",
            content: [{ type: "input_text", text: userPrompt }],
          },
        ],
      });

      const { parsedJson, text: rawText, usage: responseUsage } =
        safeExtractOpenAIResponse(response);

      let payload: RawProfileResponse | null = null;

      lastRequestMaxTokens = requestMaxTokens;

      if (parsedJson && typeof parsedJson === "object") {
        payload = parsedJson as RawProfileResponse;
      } else if (rawText && rawText.trim().length) {
        try {
          payload = JSON.parse(rawText) as RawProfileResponse;
        } catch (parseError) {
          const err = new Error("profile_invalid_json");
          (err as Error & { cause?: unknown; raw?: string }).cause = parseError;
          (err as Error & { cause?: unknown; raw?: string }).raw =
            rawText.slice(0, 2000);
          throw err;
        }
      }

      if (!payload) {
        throw new Error("Profile agent returned an empty payload");
      }

      parsedPayload = payload;
      responseModel = response.model || attempt.model;
      usage = {
        inputTokens: responseUsage?.prompt_tokens ?? 0,
        outputTokens: responseUsage?.completion_tokens ?? 0,
      };
      selectedAttemptIndex = index;
      break;
    } catch (error) {
      lastError = error;
      // eslint-disable-next-line no-console
      console.warn("[PROFILE] attempt failed", {
        attempt: attempts[index],
        error,
      });

      if (
        error &&
        typeof error === "object" &&
        (error as { code?: string }).code === "openai_response_incomplete"
      ) {
        dynamicMaxOutputTokens = Math.min(
          Math.ceil(dynamicMaxOutputTokens * 2),
          MAX_OUTPUT_TOKENS_CAP,
        );

        // ensure the next attempt runs with the leanest configuration available
        if (index + 1 < attempts.length) {
          attempts[index + 1] = {
            ...attempts[index + 1],
            verbosity: "low",
            effort: "minimal",
          };
        }
        continue;
      }

      if (
        error instanceof Error &&
        error.message === "profile_invalid_json"
      ) {
        dynamicMaxOutputTokens = Math.min(
          Math.ceil(dynamicMaxOutputTokens * 1.5),
          MAX_OUTPUT_TOKENS_CAP,
        );
        if (index + 1 < attempts.length) {
          attempts[index + 1] = {
            ...attempts[index + 1],
            verbosity: "low",
            effort: "minimal",
          };
        }
        continue;
      }
    }
  }

  if (!parsedPayload) {
    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new Error("Failed to generate document profile");
  }

  const storySummary = truncateWords(
    (toNullableString(parsedPayload.summary) ?? "").trim(),
    120,
  );
  const intention = truncateWords(
    (toNullableString(parsedPayload.intention) ?? "").trim(),
    60,
  );
  const readerPoints = normalizeReaderPoints(parsedPayload.readerPoints);
  const translationNotes = parseTranslationNotes(parsedPayload.translationNotes);

  const selectedAttempt =
    attempts[Math.max(0, selectedAttemptIndex)] ?? attempts[0];

  return {
    summary: {
      story: storySummary,
      intention,
      readerPoints,
    },
    metrics: {
      wordCount,
      charCount,
      paragraphCount,
      readingTimeMinutes,
      readingTimeLabel,
    },
    model: responseModel,
    usage,
    sourceHash,
    sourcePreview,
    translationNotes,
    meta: {
      verbosity: selectedAttempt.verbosity,
      reasoningEffort: selectedAttempt.effort,
      maxOutputTokens: lastRequestMaxTokens,
      chunkCount: 1,
      retryCount: Math.max(0, selectedAttemptIndex),
      truncated: wasTruncated,
    },
  };
}
