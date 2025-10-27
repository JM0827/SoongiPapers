import { OpenAI } from "openai";
import type { TranslationNotes } from "../../models/DocumentProfile";
import type { OriginSegment } from "./segmentationAgent";
import { buildDraftSystemPrompt } from "./promptBuilder";

export interface TranslationDraftAgentOptions {
  projectId: string;
  jobId: string;
  runOrder: number;
  sourceHash: string;
  originLanguage?: string | null;
  targetLanguage?: string | null;
  originSegments: OriginSegment[];
  translationNotes?: TranslationNotes | null;
  model?: string;
  temperature?: number;
  topP?: number;
  candidateCount?: number;
  deliberationModel?: string;
  projectTitle?: string | null;
  authorName?: string | null;
  synopsis?: string | null;
  register?: string | null;
}

export interface DraftSpanPair {
  source_span_id: string;
  source_start: number;
  source_end: number;
  target_start: number;
  target_end: number;
  note?: string;
  confidence?: number;
}

export interface DraftCandidateVariant {
  candidate_id: string;
  text: string;
  rationale?: string;
  score?: number;
  selected?: boolean;
}

export interface TranslationDraftAgentSegmentResult {
  segment_id: string;
  origin_segment: string;
  translation_segment: string;
  notes: string[];
  spanPairs?: DraftSpanPair[];
  candidates?: DraftCandidateVariant[];
}

export interface TranslationDraftAgentResult {
  model: string;
  temperature: number;
  topP: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  segments: TranslationDraftAgentSegmentResult[];
  mergedText: string;
}

interface DraftCandidate {
  id: string;
  segments: TranslationDraftAgentSegmentResult[];
  mergedText: string;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

const DEFAULT_TRANSLATION_MODEL =
  process.env.TRANSLATION_DRAFT_MODEL || process.env.CHAT_MODEL || "gpt-4o";
const DEFAULT_JUDGE_MODEL =
  process.env.TRANSLATION_DRAFT_JUDGE_MODEL || process.env.CHAT_MODEL || "gpt-4o";
const parsedCandidateEnv = Number(
  process.env.TRANSLATION_DRAFT_CANDIDATES ?? "1",
);
const DEFAULT_CANDIDATE_COUNT = Number.isFinite(parsedCandidateEnv)
  ? Math.max(1, Math.min(3, parsedCandidateEnv))
  : 1;
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_TOP_P = 0.9;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

interface DraftLLMResponse {
  segments: Array<{
    segmentId: string;
    translation: string;
    notes?: string[];
  }>;
  commentary?: string;
}

function coerceSegments(value: unknown): DraftLLMResponse["segments"] | null {
  const normalizeEntry = (
    entry: unknown,
  ): DraftLLMResponse["segments"][number] | null => {
    if (!entry || typeof entry !== "object") return null;
    const candidate = entry as Record<string, unknown>;
    const segmentId = candidate.segmentId ?? candidate.segment_id;
    const translation = candidate.translation ?? candidate.translation_segment;
    if (typeof segmentId !== "string" || typeof translation !== "string") {
      return null;
    }
    const notes = Array.isArray(candidate.notes)
      ? candidate.notes.filter((note): note is string => typeof note === "string")
      : [];
    return notes.length
      ? { segmentId, translation, notes }
      : { segmentId, translation };
  };

  const visitQueue: unknown[] = [];
  const seen = new Set<unknown>();
  visitQueue.push(value);

  while (visitQueue.length) {
    const current = visitQueue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);

    if (Array.isArray(current)) {
      const normalized = current
        .map((entry) => normalizeEntry(entry))
        .filter(
          (
            entry,
          ): entry is DraftLLMResponse["segments"][number] => entry !== null,
        );
      if (normalized.length === current.length && normalized.length > 0) {
        return normalized;
      }
      visitQueue.push(...current);
      continue;
    }

    if (typeof current === "object") {
      const record = current as Record<string, unknown>;
      if (record.segments) {
        const normalized = coerceSegments(record.segments);
        if (normalized?.length) {
          return normalized;
        }
      }
      for (const valueEntry of Object.values(record)) {
        if (valueEntry && typeof valueEntry === "object") {
          visitQueue.push(valueEntry);
        }
      }
    }
  }

  return null;
}

const draftResponseSchema = {
  name: "translation_draft_segments",
  schema: {
    type: "object",
    required: ["segments"],
    properties: {
      segments: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["segmentId", "translation"],
          properties: {
            segmentId: { type: "string" },
            translation: { type: "string" },
            notes: {
              type: "array",
              items: { type: "string" },
              default: [],
            },
          },
        },
      },
      commentary: { type: "string" },
    },
  },
};

const deliberationResponseSchema = {
  name: "draft_candidate_judgement",
  schema: {
    type: "object",
    required: ["bestCandidateId", "analysis"],
    properties: {
      bestCandidateId: { type: "string" },
      rationale: { type: "string" },
      analysis: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["candidateId", "summary"],
          properties: {
            candidateId: { type: "string" },
            summary: { type: "string" },
            score: { type: "number" },
          },
        },
      },
    },
  },
};

function buildUserPromptPayload(options: TranslationDraftAgentOptions) {
  const payload: Record<string, unknown> = {
    projectId: options.projectId,
    jobId: options.jobId,
    runOrder: options.runOrder,
    sourceHash: options.sourceHash,
    originLanguage: options.originLanguage ?? null,
    targetLanguage: options.targetLanguage ?? "English",
    segments: options.originSegments.map((segment) => ({
      segmentId: segment.id,
      text: segment.text,
      paragraphIndex: segment.paragraphIndex,
      sentenceIndex: segment.sentenceIndex,
    })),
  };

  if (options.translationNotes) {
    payload.translationNotes = options.translationNotes;
  }

  return payload;
}

function validateDraftResponse(
  response: DraftLLMResponse,
  expectedIds: string[],
) {
  if (!response?.segments?.length) {
    throw new Error("Draft response did not include any segments");
  }
  const providedIds = new Set(response.segments.map((segment) => segment.segmentId));
  const missing = expectedIds.filter((id) => !providedIds.has(id));
  if (missing.length) {
    throw new Error(
      `Draft response missing segments: ${missing.slice(0, 5).join(", ")}`,
    );
  }
}

export async function generateTranslationDraft(
  options: TranslationDraftAgentOptions,
): Promise<TranslationDraftAgentResult> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for translation draft agent");
  }
  if (!options.originSegments?.length) {
    throw new Error("originSegments are required for translation draft agent");
  }

  const model = options.model ?? DEFAULT_TRANSLATION_MODEL;
  const temperature =
    typeof options.temperature === "number"
      ? options.temperature
      : DEFAULT_TEMPERATURE;
  const topP = typeof options.topP === "number" ? options.topP : DEFAULT_TOP_P;

  const systemPrompt = buildDraftSystemPrompt({
    projectTitle: options.projectTitle ?? null,
    authorName: options.authorName ?? null,
    synopsis: options.synopsis ?? null,
    register: options.register ?? null,
    sourceLanguage: options.originLanguage ?? null,
    targetLanguage: options.targetLanguage ?? null,
    translationNotes: options.translationNotes ?? null,
  });

  const userPayload = buildUserPromptPayload(options);
  const candidateCount = Math.max(
    1,
    Math.min(3, options.candidateCount ?? DEFAULT_CANDIDATE_COUNT),
  );

  const candidates: DraftCandidate[] = [];
  let aggregateUsage = { inputTokens: 0, outputTokens: 0 };

  for (let index = 0; index < candidateCount; index += 1) {
    const candidate = await requestDraftCandidate({
      userPayload,
      systemPrompt,
      model,
      temperature,
      topP,
      options,
    });
    const candidateId = candidateCount === 1 ? "candidate-1" : `candidate-${index + 1}`;
    candidates.push({
      id: candidateId,
      ...candidate,
    });
    aggregateUsage.inputTokens += candidate.usage.inputTokens;
    aggregateUsage.outputTokens += candidate.usage.outputTokens;
  }

  let selectedCandidate = candidates[0];
  const candidateAnalyses: Record<string, { summary: string; score?: number }> = {};

  if (candidates.length > 1) {
    const deliberation = await deliberateDraftCandidates({
      candidates,
      originSegments: options.originSegments,
      sourceLanguage: options.originLanguage ?? null,
      targetLanguage: options.targetLanguage ?? null,
      translationNotes: options.translationNotes ?? null,
      model: options.deliberationModel ?? DEFAULT_JUDGE_MODEL,
    });
    if (deliberation) {
      aggregateUsage.inputTokens += deliberation.usage.inputTokens;
      aggregateUsage.outputTokens += deliberation.usage.outputTokens;
      const winner = candidates.find(
        (candidate) => candidate.id === deliberation.bestCandidateId,
      );
      if (winner) {
        selectedCandidate = winner;
      }
      for (const entry of deliberation.analysis) {
        candidateAnalyses[entry.candidateId] = {
          summary: entry.summary,
          score: entry.score,
        };
      }
    }
  }

  const candidateSegmentMap = new Map<string, Map<string, TranslationDraftAgentSegmentResult>>();
  candidates.forEach((candidate) => {
    candidateSegmentMap.set(
      candidate.id,
      new Map(candidate.segments.map((segment) => [segment.segment_id, segment])),
    );
  });

  const enrichedSegments = selectedCandidate.segments.map((segment) => {
    const variants: DraftCandidateVariant[] = candidates.map((candidate) => {
      const candidateSegment = candidateSegmentMap
        .get(candidate.id)
        ?.get(segment.segment_id);
      return {
        candidate_id: candidate.id,
        text: candidateSegment?.translation_segment ?? segment.translation_segment,
        rationale: candidateAnalyses[candidate.id]?.summary,
        score: candidateAnalyses[candidate.id]?.score,
        selected: candidate.id === selectedCandidate.id,
      };
    });
    return {
      ...segment,
      spanPairs:
        segment.spanPairs ??
        buildSpanPairs(
          segment.segment_id,
          segment.origin_segment,
          segment.translation_segment,
        ),
      candidates: variants,
    } satisfies TranslationDraftAgentSegmentResult;
  });

  return {
    model: selectedCandidate.model,
    temperature,
    topP,
    usage: aggregateUsage,
    segments: enrichedSegments,
    mergedText: selectedCandidate.mergedText,
  };
}

interface RequestCandidateParams {
  userPayload: Record<string, unknown>;
  systemPrompt: string;
  model: string;
  temperature: number;
  topP: number;
  options: TranslationDraftAgentOptions;
}

async function requestDraftCandidate(params: RequestCandidateParams): Promise<{
  segments: TranslationDraftAgentSegmentResult[];
  mergedText: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}> {
  const { userPayload, systemPrompt, model, temperature, topP, options } = params;

  const maxAttempts = 2;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await openai.chat.completions.create({
        model,
        temperature,
        top_p: topP,
        response_format: {
          type: "json_schema",
          json_schema: draftResponseSchema,
        },
        messages: [
          {
            role: "system",
            content:
              attempt === 0
                ? systemPrompt
                : `${systemPrompt}\nIf the previous output was invalid, respond with VALID JSON that matches the schema exactly. Include every provided segmentId. Do not add commentary or markdown fences.`,
          },
          {
            role: "user",
            content:
              attempt === 0
                ? `Translate the following origin segments. Respond with JSON following the schema.`
                : `Reminder: Return JSON only. Include an entry for every segmentId, even if you must reuse the origin text.`,
          },
          {
            role: "user",
            content: JSON.stringify(userPayload),
          },
        ],
      });

      const content = response.choices[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(content) as DraftLLMResponse;

      if (!parsed?.segments?.length) {
        const recovered = coerceSegments(parsed);
        if (recovered?.length) {
          parsed.segments = recovered;
        }
      }

      const expectedIds = options.originSegments.map((segment) => segment.id);
      validateDraftResponse(parsed, expectedIds);

      const segmentMap = new Map(
        parsed.segments.map((segment) => [segment.segmentId, segment]),
      );

      const orderedSegments: TranslationDraftAgentSegmentResult[] =
        options.originSegments.map((segment) => {
          const generated = segmentMap.get(segment.id);
          if (!generated) {
            throw new Error(`Missing generated segment for ${segment.id}`);
          }
          const cleanedTranslation = generated.translation.trim();
          const safeTranslation = cleanedTranslation.length
            ? cleanedTranslation
            : segment.text;
          return {
            segment_id: segment.id,
            origin_segment: segment.text,
            translation_segment: safeTranslation,
            notes: generated.notes ?? [],
            spanPairs: buildSpanPairs(segment.id, segment.text, safeTranslation),
          };
        });

      const mergedText = mergeSegmentsToText(options.originSegments, orderedSegments);

      return {
        model: response.model || model,
        segments: orderedSegments,
        mergedText,
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
        },
      };
    } catch (error) {
      const parsedError =
        error instanceof Error
          ? error
          : new Error(typeof error === "string" ? error : "Unknown error");
      lastError = parsedError;

      if (attempt === maxAttempts - 1) {
        console.error(
          "[TRANSLATION] Draft candidate generation failed",
          {
            projectId: options.projectId,
            jobId: options.jobId,
            runOrder: options.runOrder,
            error: parsedError.message,
          },
        );
        throw parsedError;
      }
    }
  }

  throw lastError ?? new Error("Failed to generate translation draft");
}

function mergeSegmentsToText(
  originSegments: OriginSegment[],
  translatedSegments: TranslationDraftAgentSegmentResult[],
): string {
  return originSegments
    .map((originSegment, index) => {
      const translated = translatedSegments[index]?.translation_segment?.trim() ?? "";
      return {
        translated,
        paragraphIndex: originSegment.paragraphIndex,
      };
    })
    .reduce((acc, current, index, array) => {
      if (!current.translated) {
        return acc;
      }
      const previous = index > 0 ? array[index - 1] : null;
      const needsParagraphBreak =
        previous !== null && previous.paragraphIndex !== current.paragraphIndex;
      const separator = index === 0 ? "" : needsParagraphBreak ? "\n\n" : "\n";
      return `${acc}${separator}${current.translated}`;
    }, "")
    .trim();
}

function buildSpanPairs(
  segmentId: string,
  originSegment: string,
  translationSegment: string,
): DraftSpanPair[] {
  return [
    {
      source_span_id: segmentId,
      source_start: 0,
      source_end: originSegment.length,
      target_start: 0,
      target_end: translationSegment.length,
    },
  ];
}

interface DeliberationResult {
  bestCandidateId: string;
  rationale?: string;
  analysis: Array<{ candidateId: string; summary: string; score?: number }>;
  usage: { inputTokens: number; outputTokens: number };
}

async function deliberateDraftCandidates(params: {
  candidates: DraftCandidate[];
  originSegments: OriginSegment[];
  sourceLanguage?: string | null;
  targetLanguage?: string | null;
  translationNotes?: TranslationNotes | null;
  model: string;
}): Promise<DeliberationResult | null> {
  const { candidates, originSegments, sourceLanguage, targetLanguage, translationNotes, model } = params;
  if (!candidates.length) {
    return null;
  }
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  try {
    const response = await openai.chat.completions.create({
      model,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: deliberationResponseSchema,
      },
      messages: [
        {
          role: "system",
          content:
            "You are an expert literary translation evaluator. Choose the candidate that best preserves meaning, glossary, and contract tone. Respond with JSON only.",
        },
        {
          role: "user",
          content: JSON.stringify({
            sourceLanguage,
            targetLanguage,
            segments: originSegments.map((segment) => ({
              segmentId: segment.id,
              text: segment.text,
            })),
            glossary: translationNotes?.namedEntities ?? [],
            candidates: candidates.map((candidate) => ({
              candidateId: candidate.id,
              translation: candidate.mergedText,
            })),
          }),
        },
      ],
    });

    const content = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(content) as {
      bestCandidateId?: string;
      rationale?: string;
      analysis?: Array<{ candidateId: string; summary: string; score?: number }>;
    };

    return {
      bestCandidateId: parsed.bestCandidateId ?? candidates[0].id,
      rationale: parsed.rationale,
      analysis: parsed.analysis ?? [],
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  } catch (error) {
    console.warn("[TRANSLATION] Candidate deliberation failed", {
      error,
    });
    return null;
  }
}
