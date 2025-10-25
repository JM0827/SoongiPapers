import { createHash } from "crypto";
import { OpenAI } from "openai";

import type { TranslationNotes } from "../../models/DocumentProfile";
import {
  DEFAULT_LOCALE,
  resolveLocale as resolveOutputLocale,
  type UILocale,
} from "../../services/localeService";

const DEFAULT_MODEL =
  process.env.PROFILE_AGENT_MODEL || process.env.CHAT_MODEL || "gpt-4o-mini";
const WORDS_PER_MINUTE = 220;
const MAX_CONTEXT_CHARS = 8000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

export type ProfileVariant = "origin" | "translation";

export interface ProfileAgentInput {
  projectId: string;
  text: string;
  variant: ProfileVariant;
  language?: string | null;
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

function parseEntityList(value: unknown): Array<{ name: string; frequency: number }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const name = toNullableString((entry as Record<string, unknown>).name) ?? "";
      if (!name) return null;
      const rawFrequency = (entry as Record<string, unknown>).frequency;
      const frequency = Number.isFinite(rawFrequency)
        ? Number(rawFrequency)
        : Number((entry as Record<string, unknown>).count ?? 0);
      return {
        name: truncateWords(name, 12),
        frequency: Number.isFinite(frequency) ? Math.max(0, frequency) : 0,
      };
    })
    .filter((entry): entry is { name: string; frequency: number } => Boolean(entry))
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
      const age = toNullableString(source.age);
      const gender = toNullableString(source.gender);
      const traits = normalizeStringArray(source.traits, 5);
      return {
        name: truncateWords(name, 12),
        age,
        gender,
        traits,
      };
    })
    .filter((entry): entry is TranslationNotes["characters"][number] => Boolean(entry))
    .slice(0, 20);
}

function parseTranslationNotes(value: unknown): TranslationNotes | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const characters = parseCharacters(raw.characters);
  const namedEntities = parseEntityList(raw.namedEntities ?? raw.entities);
  const locations = parseEntityList(raw.locations);
  const measurementUnits = normalizeStringArray(raw.measurementUnits ?? raw.units);
  const linguisticFeatures = normalizeStringArray(
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
    text.length > MAX_CONTEXT_CHARS
      ? `${text.slice(0, MAX_CONTEXT_CHARS)}\n\n[... 생략됨 ...]`
      : text;
  const sourceHash = createHash("sha256").update(text).digest("hex");
  const sourcePreview = text.slice(0, 600);

  const variantLabel = input.variant === "origin" ? "original" : "translated";
  const languageHint = input.language
    ? `Expected language: ${input.language}.`
    : "";

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
Tasks:
1. Provide a vivid but concise story summary (<= 120 words).
2. State the author's narrative intention or purpose (<= 50 words).
3. List 2-4 reader takeaways or emotional touchpoints (each <= 35 words).
4. Extract Translation Notes as JSON with:
   - characters: [{ name, age?, gender?, traits[] }]
   - namedEntities: top 20 [{ name, frequency }]
   - timePeriod: string | null
   - locations: top 20 [{ name, frequency }]
   - measurementUnits: up to 20 strings
   - linguisticFeatures: up to 20 strings (slang, idioms, dialect markers)

${localeInstruction}
Respond strictly as JSON with keys: summary (string), intention (string), readerPoints (string[]), translationNotes (object).

Text to analyze:
"""
${truncated}
"""`;

  const completion = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    temperature: 0.5,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const content = completion.choices[0]?.message?.content ?? "{}";

  let parsed: {
    summary?: string;
    intention?: string;
    readerPoints?: unknown;
    translationNotes?: unknown;
  };
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Failed to parse profile agent payload: ${(error as Error).message}`,
    );
  }

  const storySummary = truncateWords((parsed.summary ?? "").trim(), 120);
  const intention = truncateWords((parsed.intention ?? "").trim(), 60);
  const readerPoints = normalizeReaderPoints(parsed.readerPoints);
  const translationNotes = parseTranslationNotes(parsed.translationNotes ?? null);

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
    model: completion.model || DEFAULT_MODEL,
    usage: {
      inputTokens: completion.usage?.prompt_tokens ?? 0,
      outputTokens: completion.usage?.completion_tokens ?? 0,
    },
    sourceHash,
    sourcePreview,
    translationNotes,
  };
}
