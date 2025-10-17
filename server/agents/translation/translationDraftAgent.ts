import { OpenAI } from "openai";
import type { TranslationNotes } from "../../models/DocumentProfile";
import type { OriginSegment } from "./segmentationAgent";

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
}

export interface TranslationDraftAgentSegmentResult {
  segment_id: string;
  origin_segment: string;
  translation_segment: string;
  notes: string[];
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

const DEFAULT_TRANSLATION_MODEL =
  process.env.TRANSLATION_DRAFT_MODEL || process.env.CHAT_MODEL || "gpt-4o";
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

  const systemPrompt = `You are a master literary translator. Produce a polished, idiomatic translation for each segment.
Return only valid JSON following the provided schema. Do not include explanations.
Guidelines:
- Reconstruct broken sentences when hard line breaks or hyphenation appear.
- Preserve narrative voice, tone, and figurative language.
- Resolve PDF/HWP artifacts (hyphenated words, bullet fragments, table cells).
- Keep inline formatting markers (#, *, …) if they carry meaning; otherwise omit.
- Ensure the translation reads like natural prose aimed at publication.
- Use double quotes for dialogue in English unless the context dictates otherwise.
- Keep paragraph relationships aligned with the provided segment order.`;

  const userPayload = buildUserPromptPayload(options);

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
          };
        });

      const mergedText = options.originSegments
        .map((originSegment, index) => {
          const translated = orderedSegments[index]?.translation_segment?.trim() ?? "";
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

      return {
        model: response.model || model,
        temperature,
        topP,
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
        },
        segments: orderedSegments,
        mergedText,
      };
    } catch (error) {
      const parsedError =
        error instanceof Error
          ? error
          : new Error(typeof error === "string" ? error : "Unknown error");
      if (attempt === maxAttempts - 1) {
        console.error(
          "[TRANSLATION] Draft generation failed",
          {
            projectId: options.projectId,
            jobId: options.jobId,
            runOrder: options.runOrder,
            error: parsedError.message,
          },
        );
      }
      lastError = parsedError;

      if (attempt === maxAttempts - 1) {
        throw parsedError;
      }
    }
  }

  throw lastError ?? new Error("Failed to generate translation draft");
}
