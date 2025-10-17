import { OpenAI } from "openai";
import type { TranslationNotes } from "../../models/DocumentProfile";
import type { OriginSegment } from "./segmentationAgent";
import type { TranslationDraftAgentSegmentResult } from "./translationDraftAgent";

export interface SynthesisCandidate {
  draftId?: string | null;
  runOrder: number;
  model?: string | null;
  temperature?: number | null;
  topP?: number | null;
  segments: TranslationDraftAgentSegmentResult[];
}

export interface TranslationSynthesisAgentOptions {
  projectId: string;
  jobId: string;
  sourceHash: string;
  originLanguage?: string | null;
  targetLanguage?: string | null;
  originSegments: OriginSegment[];
  translationNotes?: TranslationNotes | null;
  candidates: SynthesisCandidate[];
  model?: string;
  temperature?: number;
  topP?: number;
}

export interface TranslationSynthesisSegmentResult {
  segment_id: string;
  translation_segment: string;
  selected_run_order: number | null;
  rationale: string | null;
}

export interface TranslationSynthesisAgentResult {
  model: string;
  temperature: number;
  topP: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  segments: TranslationSynthesisSegmentResult[];
  mergedText: string;
}

const DEFAULT_SYNTHESIS_MODEL =
  process.env.TRANSLATION_SYNTHESIS_MODEL || process.env.CHAT_MODEL || "gpt-4o";
const DEFAULT_SYNTHESIS_TEMPERATURE = 0.35;
const DEFAULT_SYNTHESIS_TOP_P = 0.85;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

interface SynthesisLLMResponseSegment {
  segmentId: string;
  translation: string;
  selectedRunOrder?: number | null;
  rationale?: string;
}

interface SynthesisLLMResponse {
  segments: SynthesisLLMResponseSegment[];
  editorialNotes?: string;
}

const synthesisResponseSchema = {
  name: "translation_synthesis_segments",
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
            selectedRunOrder: { type: ["integer", "null"], default: null },
            rationale: { type: "string" },
          },
        },
      },
      editorialNotes: { type: "string" },
    },
  },
};

function buildSynthesisPayload(options: TranslationSynthesisAgentOptions) {
  const segments = options.originSegments.map((segment) => ({
    segmentId: segment.id,
    origin: segment.text,
    paragraphIndex: segment.paragraphIndex,
    sentenceIndex: segment.sentenceIndex,
    candidates: options.candidates.map((candidate) => {
      const segmentMatch = candidate.segments.find(
        (entry) => entry.segment_id === segment.id,
      );
      return {
        runOrder: candidate.runOrder,
        draftId: candidate.draftId,
        model: candidate.model,
        temperature: candidate.temperature,
        topP: candidate.topP,
        translation: segmentMatch?.translation_segment ?? null,
        notes: segmentMatch?.notes ?? [],
      };
    }),
  }));

  return {
    projectId: options.projectId,
    jobId: options.jobId,
    sourceHash: options.sourceHash,
    originLanguage: options.originLanguage ?? null,
    targetLanguage: options.targetLanguage ?? "English",
    candidates: options.candidates.map((candidate) => ({
      runOrder: candidate.runOrder,
      draftId: candidate.draftId,
      model: candidate.model ?? null,
      temperature: candidate.temperature ?? null,
      topP: candidate.topP ?? null,
    })),
    segments,
    translationNotes: options.translationNotes ?? null,
  };
}

function ensureSegmentsCoverAll(
  response: SynthesisLLMResponse,
  expectedIds: string[],
) {
  if (!response?.segments?.length) {
    throw new Error("Synthesis response did not include any segments");
  }
  const provided = new Set(response.segments.map((segment) => segment.segmentId));
  const missing = expectedIds.filter((id) => !provided.has(id));
  if (missing.length) {
    throw new Error(
      `Synthesis response missing segments: ${missing.slice(0, 5).join(", ")}`,
    );
  }
}

export async function synthesizeTranslation(
  options: TranslationSynthesisAgentOptions,
): Promise<TranslationSynthesisAgentResult> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for translation synthesis agent");
  }
  if (!options.candidates?.length) {
    throw new Error("At least one translation candidate is required for synthesis");
  }
  if (!options.originSegments?.length) {
    throw new Error("originSegments are required for synthesis");
  }

  const model = options.model ?? DEFAULT_SYNTHESIS_MODEL;
  const temperature =
    typeof options.temperature === "number"
      ? options.temperature
      : DEFAULT_SYNTHESIS_TEMPERATURE;
  const topP =
    typeof options.topP === "number" ? options.topP : DEFAULT_SYNTHESIS_TOP_P;

  const systemPrompt = `You are a senior literary editor combining multiple candidate translations into a single, publication-ready result.
For each origin segment, choose the strongest candidate translation or synthesize an improved version drawing on the best qualities available.
Return only valid JSON following the schema. Do not include explanations outside JSON.
Guidelines:
- Preserve meaning, tone, pacing, and character voice from the origin.
- Prefer fluent, idiomatic English suitable for publication.
- Merge or rewrite when no candidate is sufficient.
- Respect consistent terminology for named entities, places, and stylistic motifs.
- Incorporate translation notes (characters, locations, slang) to maintain continuity.
- Maintain alignment: each output segment must correspond to the same origin segment.`;

  const payload = buildSynthesisPayload(options);

  const response = await openai.chat.completions.create({
    model,
    temperature,
    top_p: topP,
    response_format: { type: "json_schema", json_schema: synthesisResponseSchema },
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content:
          "Combine the candidate translations segment-by-segment and respond with JSON following the schema.",
      },
      {
        role: "user",
        content: JSON.stringify(payload),
      },
    ],
  });

  const content = response.choices[0]?.message?.content ?? "{}";
  let parsed: SynthesisLLMResponse;
  try {
    parsed = JSON.parse(content) as SynthesisLLMResponse;
  } catch (error) {
    throw new Error(
      `Failed to parse synthesis response: ${(error as Error).message}`,
    );
  }

  const expectedIds = options.originSegments.map((segment) => segment.id);
  ensureSegmentsCoverAll(parsed, expectedIds);

  const responseMap = new Map(
    parsed.segments.map((segment) => [segment.segmentId, segment]),
  );

  const orderedSegments: TranslationSynthesisSegmentResult[] =
    options.originSegments.map((segment) => {
      const generated = responseMap.get(segment.id);
      if (!generated) {
        throw new Error(`Missing synthesized segment for ${segment.id}`);
      }
      return {
        segment_id: segment.id,
        translation_segment: generated.translation.trim(),
        selected_run_order:
          typeof generated.selectedRunOrder === "number"
            ? generated.selectedRunOrder
            : null,
        rationale: generated.rationale?.trim() ?? null,
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
}
