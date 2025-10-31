import { getOpenAIClient } from "./openaiClient";
import {
  resolveGenreAlias,
  getGenreById,
} from "../repositories/articleGenresRepository";
import { upsertDraftMetadata } from "../repositories/draftMetadataRepository";

export type DraftAnalysisRequest = {
  userId: string;
  text: string;
  source: {
    fileName: string | null;
    fileType: string | null;
  };
  stats: {
    wordCount: number;
    characterCount: number;
  };
  locale?: string;
};

export type DraftAnalysisResult = {
  title: string;
  summary: string;
  language: string;
  tags: string[];
  primaryType: string;
  stats: {
    wordCount: number;
    characterCount: number;
    readingMinutes: number;
  };
  genres: {
    primary?: GenreSelection;
    primarySubgenre?: GenreSelection;
    secondary: GenreSelection[];
  };
  unresolvedGenres: string[];
};

export type GenreSelection = {
  id: string | null;
  label: string;
};

type ModelResponse = {
  title: string;
  summary: string;
  language: string;
  tags: string[];
  genres: {
    primary?: {
      name: string;
      subgenre?: string | null;
    } | null;
    secondary?: Array<{
      name: string;
      subgenre?: string | null;
    }>;
  };
};

const MAX_MODEL_INPUT_CHARS = 8000;

export async function analyzeDraftContent(
  request: DraftAnalysisRequest,
): Promise<DraftAnalysisResult> {
  const openai = getOpenAIClient();
  const truncatedText =
    request.text.length > MAX_MODEL_INPUT_CHARS
      ? `${request.text.slice(0, MAX_MODEL_INPUT_CHARS)}\n\n[Content truncated for analysis]`
      : request.text;

  const prompt = buildPrompt(request, truncatedText);
  const completion = await openai.chat.completions.create({
    model: "gpt-5o-mini",
    messages: prompt,
    temperature: 0.2,
  });

  const rawContent = completion.choices[0]?.message?.content;
  if (!rawContent) {
    throw new Error("Create agent did not return a response");
  }

  let parsed: ModelResponse | null = null;
  try {
    const jsonString = extractJson(rawContent);
    parsed = JSON.parse(jsonString) as ModelResponse;
  } catch (error) {
    throw new Error(
      `Unable to parse create agent response: ${(error as Error).message}`,
    );
  }

  if (!parsed) {
    throw new Error("Create agent returned empty payload");
  }

  const stats = {
    wordCount: request.stats.wordCount,
    characterCount: request.stats.characterCount,
    readingMinutes: Math.max(1, Math.round(request.stats.wordCount / 200)),
  };

  const languageFromModel = normalizeLanguageCode(parsed.language);
  const fallbackLanguage =
    languageFromModel ??
    inferLanguageFromText(request.text) ??
    normalizeLanguageCode(request.locale) ??
    "en";

  const unresolved: string[] = [];
  const genres = await resolveGenres(
    parsed.genres ?? {},
    fallbackLanguage,
    unresolved,
  );

  const result: DraftAnalysisResult = {
    title: parsed.title?.trim() || generateFallbackTitle(request.text),
    summary: enforceSummaryLimit(parsed.summary ?? ""),
    language: fallbackLanguage,
    tags: Array.isArray(parsed.tags)
      ? parsed.tags.map((tag) => tag.trim()).filter(Boolean)
      : [],
    primaryType: inferPrimaryType(parsed.genres),
    stats,
    genres,
    unresolvedGenres: unresolved,
  };

  await upsertDraftMetadata({
    userId: request.userId,
    metadata: {
      title: result.title,
      summary: result.summary,
      language: result.language,
      tags: result.tags,
      stats: result.stats,
      genres: result.genres,
      unresolvedGenres: result.unresolvedGenres,
    },
    sourceFileName: request.source.fileName,
    sourceFileType: request.source.fileType,
  });

  return result;
}

function buildPrompt(request: DraftAnalysisRequest, truncatedText: string) {
  const systemInstructions = `You are CreateAgent, a literary content analyst for Bookko.com.
Given draft content, produce structured metadata in JSON.

Rules:
- Always respond with valid JSON only.
- Limit summary to 100 words maximum.
- Tags should be 5-8 concise keywords without leading '#'.
- Genres must include top-level and sub-genre names (even if you must infer).`;

  const metadata = {
    wordCount: request.stats.wordCount,
    characterCount: request.stats.characterCount,
  };

  return [
    { role: "system" as const, content: systemInstructions },
    {
      role: "user" as const,
      content: `Draft metadata (counts already measured): ${JSON.stringify(metadata)}\n\nDraft content:\n${truncatedText}`,
    },
  ];
}

function extractJson(response: string): string {
  const start = response.indexOf("{");
  const end = response.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found in model response");
  }
  return response.slice(start, end + 1);
}

function enforceSummaryLimit(summary: string): string {
  if (!summary) return "";
  const words = summary.trim().split(/\s+/);
  if (words.length <= 100) return summary.trim();
  return words.slice(0, 100).join(" ") + "…";
}

function generateFallbackTitle(text: string): string {
  const condensed = text.replace(/\s+/g, " ").trim();
  if (condensed.length <= 64) return condensed || "Untitled Draft";
  return `${condensed.slice(0, 61)}…`;
}

function inferPrimaryType(
  genres: ModelResponse["genres"] | null | undefined,
): string {
  const candidates = [
    genres?.primary?.name,
    genres?.primary?.subgenre,
    genres?.secondary?.[0]?.name,
  ]
    .filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    )
    .map((value) => value.toLowerCase());

  if (candidates.some((value) => value.includes("essay"))) {
    return "essay";
  }
  if (candidates.some((value) => value.includes("thought"))) {
    return "thoughts";
  }
  return "novel";
}

async function resolveGenres(
  genres: NonNullable<ModelResponse["genres"]>,
  locale: string,
  unresolved: string[],
): Promise<DraftAnalysisResult["genres"]> {
  const primary = await resolveSingleGenre(
    genres.primary?.name ?? "",
    locale,
    unresolved,
  );
  const primarySub = await resolveSingleGenre(
    genres.primary?.subgenre ?? "",
    locale,
    unresolved,
  );

  const secondary: GenreSelection[] = [];
  for (const entry of genres.secondary ?? []) {
    const resolved = await resolveSingleGenre(
      entry.name ?? "",
      locale,
      unresolved,
    );
    if (resolved) {
      pushIfUnique(secondary, resolved);
    } else if (entry.name) {
      unresolved.push(entry.name);
    }

    if (entry.subgenre) {
      const resolvedSub = await resolveSingleGenre(
        entry.subgenre,
        locale,
        unresolved,
      );
      if (resolvedSub) {
        pushIfUnique(secondary, resolvedSub);
      }
    }
  }

  return {
    primary: primary ?? undefined,
    primarySubgenre: primarySub ?? undefined,
    secondary,
  };
}

async function resolveSingleGenre(
  label: string,
  locale: string,
  unresolved: string[],
): Promise<GenreSelection | null> {
  const normalized = label?.trim();
  if (!normalized) return null;

  const alias = await resolveGenreAlias(normalized, locale);
  if (alias) {
    return { id: alias.id, label: alias.name };
  }

  const fallback = await resolveGenreAlias(normalized, "en");
  if (fallback) {
    return { id: fallback.id, label: fallback.name };
  }

  // As a last resort, attempt to load by ID if the label already matches one.
  try {
    const candidate = await getGenreById(normalized, locale);
    if (candidate) {
      return { id: candidate.id, label: candidate.name };
    }
  } catch {
    // ignore lookup errors
  }

  unresolved.push(normalized);
  return { id: null, label: normalized };
}

function pushIfUnique(
  collection: GenreSelection[],
  candidate: GenreSelection,
): void {
  const exists = collection.some((item) =>
    item.id && candidate.id
      ? item.id === candidate.id
      : item.label.toLowerCase() === candidate.label.toLowerCase(),
  );
  if (!exists) {
    collection.push(candidate);
  }
}

function normalizeLanguageCode(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const lower = value.trim().toLowerCase();
  if (!lower) return null;

  const synonyms: Record<string, string | null> = {
    english: "en",
    "en-us": "en",
    "en-gb": "en",
    korean: "ko",
    hangul: "ko",
    japanese: "ja",
    hiragana: "ja",
    katakana: "ja",
    chinese: "zh",
    "simplified chinese": "zh",
    "traditional chinese": "zh",
    mandarin: "zh",
    cantonese: "zh",
    spanish: "es",
    castilian: "es",
    french: "fr",
    german: "de",
    italian: "it",
    portuguese: "pt",
    russian: "ru",
    arabic: "ar",
    hindi: "hi",
    bengali: "bn",
    indonesian: "id",
    vietnamese: "vi",
    thai: "th",
    unknown: null,
    und: null,
    "n/a": null,
  };

  if (lower in synonyms) {
    return synonyms[lower] ?? null;
  }

  if (/^[a-z]{2}$/.test(lower)) {
    return lower;
  }

  if (/^[a-z]{2}-[a-z0-9]{2,}$/.test(lower)) {
    return lower.slice(0, 2);
  }

  if (/^[a-z]{3}$/.test(lower)) {
    return lower;
  }

  return lower;
}

function inferLanguageFromText(text: string): string | null {
  const sample = text.slice(0, 4000);
  if (!sample.trim()) return null;

  const counts = {
    hangul: countMatches(sample, /[\uAC00-\uD7A3]/g),
    han: countMatches(sample, /[\u4E00-\u9FFF]/g),
    hiragana: countMatches(sample, /[\u3040-\u309F]/g),
    katakana: countMatches(sample, /[\u30A0-\u30FF]/g),
    cyrillic: countMatches(sample, /[\u0400-\u04FF]/g),
    arabic: countMatches(sample, /[\u0600-\u06FF]/g),
    devanagari: countMatches(sample, /[\u0900-\u097F]/g),
    latin: countMatches(sample, /[A-Za-z]/g),
  };

  const kana = counts.hiragana + counts.katakana;
  const totals =
    counts.hangul +
    counts.han +
    kana +
    counts.cyrillic +
    counts.arabic +
    counts.devanagari +
    counts.latin;
  const minimum = Math.max(20, Math.floor(totals * 0.15));

  if (counts.hangul >= Math.max(10, minimum)) return "ko";
  if (kana >= Math.max(10, minimum)) return "ja";
  if (counts.han >= Math.max(10, minimum)) return "zh";
  if (counts.cyrillic >= Math.max(10, Math.floor(totals * 0.2))) return "ru";
  if (counts.arabic >= Math.max(10, Math.floor(totals * 0.2))) return "ar";
  if (counts.devanagari >= Math.max(10, Math.floor(totals * 0.2))) return "hi";
  if (counts.latin >= Math.max(15, Math.floor(totals * 0.25))) return "en";

  return null;
}

function countMatches(text: string, pattern: RegExp): number {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}
