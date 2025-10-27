import { OpenAI } from 'openai';

import type { TranslationNotes } from '../../models/DocumentProfile';
import type { OriginSegment } from './segmentationAgent';
import type { TranslationDraftAgentSegmentResult } from './translationDraftAgent';
import { safeExtractOpenAIResponse } from '../../services/llm';

import type { ResponseReasoningEffort, ResponseVerbosity } from './translationDraftAgent';

export interface SynthesisCandidate {
  draftId?: string | null;
  runOrder: number;
  model?: string | null;
  verbosity?: ResponseVerbosity | null;
  reasoningEffort?: ResponseReasoningEffort | null;
  maxOutputTokens?: number | null;
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
  verbosity?: ResponseVerbosity;
  reasoningEffort?: ResponseReasoningEffort;
  maxOutputTokens?: number;
}

export interface TranslationSynthesisSegmentResult {
  segment_id: string;
  translation_segment: string;
  selected_run_order: number | null;
  rationale: string | null;
}

export interface TranslationSynthesisAgentResultMeta {
  verbosity: ResponseVerbosity;
  reasoningEffort: ResponseReasoningEffort;
  maxOutputTokens: number;
  retryCount: number;
  truncated: boolean;
  fallbackModelUsed: boolean;
}

export interface TranslationSynthesisAgentResult {
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  segments: TranslationSynthesisSegmentResult[];
  mergedText: string;
  meta: TranslationSynthesisAgentResultMeta;
}

const DEFAULT_SYNTHESIS_MODEL =
  process.env.TRANSLATION_SYNTHESIS_MODEL?.trim() ||
  process.env.CHAT_MODEL?.trim() ||
  'gpt-5';
const FALLBACK_SYNTHESIS_MODEL =
  process.env.TRANSLATION_SYNTHESIS_VALIDATION_MODEL?.trim() ||
  'gpt-5-mini';
const DEFAULT_SYNTHESIS_VERBOSITY = normalizeVerbosity(
  process.env.TRANSLATION_SYNTHESIS_VERBOSITY,
);
const DEFAULT_SYNTHESIS_REASONING_EFFORT = normalizeReasoningEffort(
  process.env.TRANSLATION_SYNTHESIS_REASONING_EFFORT,
);
const DEFAULT_SYNTHESIS_MAX_OUTPUT_TOKENS = normalizePositiveInteger(
  process.env.TRANSLATION_SYNTHESIS_MAX_OUTPUT_TOKENS,
  2200,
);
const SYNTHESIS_MAX_OUTPUT_TOKENS_CAP = normalizePositiveInteger(
  process.env.TRANSLATION_SYNTHESIS_MAX_OUTPUT_TOKENS_CAP,
  5200,
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || '',
});

const synthesisResponseSchema = {
  name: 'translation_synthesis_segments',
  schema: {
    type: 'object',
    required: ['segments'],
    additionalProperties: false,
    properties: {
      segments: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            segmentId: { type: 'string' },
            translation: { type: 'string' },
            selectedRunOrder: { type: ['integer', 'null'], default: null },
            rationale: { type: ['string', 'null'], default: null },
          },
          required: ['segmentId', 'translation'],
        },
      },
      editorialNotes: { type: ['string', 'null'], default: null },
    },
  },
};

function normalizeVerbosity(value: string | undefined | null): ResponseVerbosity {
  if (!value) return 'high';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high') {
    return normalized;
  }
  return 'high';
}

function normalizeReasoningEffort(
  value: string | undefined | null,
): ResponseReasoningEffort {
  if (!value) return 'medium';
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'minimal' ||
    normalized === 'low' ||
    normalized === 'medium' ||
    normalized === 'high'
  ) {
    return normalized;
  }
  return 'medium';
}

function normalizePositiveInteger(
  value: string | undefined | null,
  fallback: number,
): number {
  const parsed = Number.parseInt((value ?? '').trim(), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

const VERBOSITY_ORDER: ResponseVerbosity[] = ['low', 'medium', 'high'];
const EFFORT_ORDER: ResponseReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
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

export async function synthesizeTranslation(
  options: TranslationSynthesisAgentOptions,
): Promise<TranslationSynthesisAgentResult> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required for translation synthesis agent');
  }
  if (!options.candidates?.length) {
    throw new Error('At least one translation candidate is required for synthesis');
  }
  if (!options.originSegments?.length) {
    throw new Error('originSegments are required for synthesis');
  }

  const baseModel = options.model?.trim() || DEFAULT_SYNTHESIS_MODEL;
  const fallbackModel = FALLBACK_SYNTHESIS_MODEL || baseModel;
  const baseVerbosity = options.verbosity || DEFAULT_SYNTHESIS_VERBOSITY;
  const baseEffort = options.reasoningEffort || DEFAULT_SYNTHESIS_REASONING_EFFORT;
  const baseMaxTokens = options.maxOutputTokens ?? DEFAULT_SYNTHESIS_MAX_OUTPUT_TOKENS;

  const systemPrompt = buildSynthesisSystemPrompt();
  const payload = buildSynthesisPayload(options);

  const attempts = buildSynthesisAttemptConfigs(
    baseModel,
    fallbackModel,
    baseVerbosity,
    baseEffort,
  );

  let dynamicMaxOutputTokens = baseMaxTokens;
  let lastRequestMaxTokens = Math.min(
    dynamicMaxOutputTokens,
    SYNTHESIS_MAX_OUTPUT_TOKENS_CAP,
  );
  let parsedPayload: {
    segments: Array<{
      segmentId: string;
      translation: string;
      selectedRunOrder?: number | null;
      rationale?: string | null;
    }>;
  } | null = null;
  let responseModel = baseModel;
  let usage = { inputTokens: 0, outputTokens: 0 };
  let selectedAttemptIndex = -1;
  let fallbackModelUsed = false;
  let truncated = false;
  let lastError: unknown = null;

  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    const requestMaxTokens = Math.min(
      dynamicMaxOutputTokens,
      SYNTHESIS_MAX_OUTPUT_TOKENS_CAP,
    );
    lastRequestMaxTokens = requestMaxTokens;

    try {
      const response = await openai.responses.create({
        model: attempt.model,
        max_output_tokens: requestMaxTokens,
        text: {
          format: {
            type: 'json_schema',
            name: synthesisResponseSchema.name,
            schema: synthesisResponseSchema.schema,
            strict: true,
          },
          verbosity: attempt.verbosity,
        },
        reasoning: { effort: attempt.effort },
       input: [
         {
           role: 'system',
           content: [{ type: 'input_text', text: systemPrompt }],
         },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text:
                  'Combine the candidate translations segment-by-segment. Return JSON matching the schema only.',
              },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'input_text', text: JSON.stringify(payload) }],
          },
        ],
      });

      const { parsedJson, text, usage: responseUsage } = safeExtractOpenAIResponse(
        response,
      );

      const raw = (parsedJson || (text ? JSON.parse(text) : null)) as
        | {
            segments?: Array<{
              segmentId?: string;
              translation?: string;
              selectedRunOrder?: number | null;
              rationale?: string | null;
            }>;
          }
        | null;

      if (!raw?.segments) {
        throw new Error('Synthesis response did not include any segments');
      }

      const normalized = raw.segments
        .map((segment) => normalizeSynthesisSegment(segment))
        .filter((segment): segment is {
          segmentId: string;
          translation: string;
          selectedRunOrder: number | null;
          rationale: string | null;
        } => segment !== null);

      if (normalized.length !== raw.segments.length) {
        throw new Error('Synthesis response returned invalid segment entries');
      }

      const expectedIds = new Set(options.originSegments.map((segment) => segment.id));
      const missing = options.originSegments
        .map((segment) => segment.id)
        .filter((id) => !normalized.some((segment) => segment.segmentId === id));
      if (missing.length) {
        throw new Error(
          `Synthesis response missing segments: ${missing.slice(0, 5).join(', ')}`,
        );
      }

      parsedPayload = { segments: normalized };
      responseModel = response.model || attempt.model;
      usage = {
        inputTokens: responseUsage?.prompt_tokens ?? 0,
        outputTokens: responseUsage?.completion_tokens ?? 0,
      };
      selectedAttemptIndex = index;
      fallbackModelUsed = fallbackModelUsed || attempt.model !== attempts[0]?.model;
      break;
    } catch (error) {
      lastError = error;
      // eslint-disable-next-line no-console
      console.warn('[TRANSLATION] Synthesis attempt failed', {
        attempt,
        error,
      });

      if (
        error &&
        typeof error === 'object' &&
        (error as { code?: string }).code === 'openai_response_incomplete'
      ) {
        truncated = true;
        dynamicMaxOutputTokens = Math.min(
          Math.ceil(dynamicMaxOutputTokens * 2),
          SYNTHESIS_MAX_OUTPUT_TOKENS_CAP,
        );
        if (index + 1 < attempts.length) {
          attempts[index + 1] = {
            ...attempts[index + 1],
            verbosity: 'medium',
            effort: 'low',
          };
        }
        continue;
      }

      if (error instanceof Error && error.name === 'SyntaxError') {
        dynamicMaxOutputTokens = Math.min(
          Math.ceil(dynamicMaxOutputTokens * 1.5),
          SYNTHESIS_MAX_OUTPUT_TOKENS_CAP,
        );
        if (index + 1 < attempts.length) {
          attempts[index + 1] = {
            ...attempts[index + 1],
            verbosity: 'low',
            effort: 'minimal',
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
    throw new Error('Failed to synthesize translation');
  }

  const responseMap = new Map(
    parsedPayload.segments.map((segment) => [segment.segmentId, segment]),
  );

  const orderedSegments: TranslationSynthesisSegmentResult[] =
    options.originSegments.map((segment) => {
      const generated = responseMap.get(segment.id);
      if (!generated) {
        throw new Error(`Missing synthesized segment for ${segment.id}`);
      }

      const cleanedTranslation = generated.translation.trim();

      if (/^\s*(summary|synopsis|overall|in summary|this (?:scene|story|chapter))/iu.test(cleanedTranslation)) {
        throw new Error(
          `Synthesis attempted to prepend a summary for segment ${segment.id}`,
        );
      }

      if (/^\s*\n/.test(generated.translation)) {
        throw new Error(
          `Synthesis attempted to prepend blank lines before segment ${segment.id}`,
        );
      }

      const hasDoubleNewline = /\n\s*\n/.test(cleanedTranslation);
      const originHasDoubleNewline = /\n\s*\n/.test(segment.text ?? '');
      if (hasDoubleNewline && !originHasDoubleNewline) {
        throw new Error(
          `Synthesis inserted a new paragraph in segment ${segment.id}`,
        );
      }

      return {
        segment_id: segment.id,
        translation_segment: cleanedTranslation,
        selected_run_order:
          typeof generated.selectedRunOrder === 'number'
            ? generated.selectedRunOrder
            : null,
        rationale: generated.rationale ?? null,
      };
    });

  const mergedText = options.originSegments
    .map((originSegment, index) => {
      const translated = orderedSegments[index]?.translation_segment?.trim() ?? '';
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
      const separator = index === 0 ? '' : needsParagraphBreak ? '\n\n' : '\n';
      return `${acc}${separator}${current.translated}`;
    }, '')
    .trim();

  const selectedAttempt =
    attempts[Math.max(0, selectedAttemptIndex)] ?? attempts[attempts.length - 1];

  return {
    model: responseModel,
    usage,
    segments: orderedSegments,
    mergedText,
    meta: {
      verbosity: selectedAttempt.verbosity,
      reasoningEffort: selectedAttempt.effort,
      maxOutputTokens: lastRequestMaxTokens,
      retryCount: Math.max(0, selectedAttemptIndex),
      truncated,
      fallbackModelUsed,
    },
  };
}

function buildSynthesisAttemptConfigs(
  baseModel: string,
  fallbackModel: string,
  baseVerbosity: ResponseVerbosity,
  baseEffort: ResponseReasoningEffort,
): Array<{
  model: string;
  verbosity: ResponseVerbosity;
  effort: ResponseReasoningEffort;
}> {
  const attempts: Array<{
    model: string;
    verbosity: ResponseVerbosity;
    effort: ResponseReasoningEffort;
  }> = [
    {
      model: baseModel,
      verbosity: baseVerbosity,
      effort: baseEffort,
    },
    {
      model: baseModel,
      verbosity: 'medium',
      effort: 'low',
    },
  ];

  if (fallbackModel && fallbackModel !== baseModel) {
    attempts.push({
      model: fallbackModel,
      verbosity: 'low',
      effort: 'minimal',
    });
  }

  return attempts;
}

function buildSynthesisSystemPrompt(): string {
  return `You are a senior literary editor combining multiple candidate translations into a single, publication-ready result.
For each origin segment, choose the strongest candidate translation or synthesize an improved version drawing on the best qualities available.
Return only valid JSON following the schema. Do not include explanations outside JSON.
Guidelines:
- Preserve meaning, tone, pacing, and character voice from the origin.
- Prefer fluent, idiomatic prose suitable for publication.
- Never prepend summaries, overviews, or transitional paragraphs that are absent from the candidates.
- Never invent new opening or closing sentences for any segment; begin with the narrative content already present.
- Merge or rewrite when no candidate is sufficient, but stay within the segment’s scope.
- Respect consistent terminology for named entities, places, and stylistic motifs.
- Incorporate translation notes (characters, locations, slang) to maintain continuity.
- Maintain alignment: each output segment must correspond to the same origin segment.`;
}

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
        draftId: candidate.draftId ?? null,
        model: candidate.model ?? null,
        verbosity: candidate.verbosity ?? null,
        reasoningEffort: candidate.reasoningEffort ?? null,
        maxOutputTokens: candidate.maxOutputTokens ?? null,
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
    targetLanguage: options.targetLanguage ?? 'English',
    candidates: options.candidates.map((candidate) => ({
      runOrder: candidate.runOrder,
      draftId: candidate.draftId ?? null,
      model: candidate.model ?? null,
      verbosity: candidate.verbosity ?? null,
      reasoningEffort: candidate.reasoningEffort ?? null,
      maxOutputTokens: candidate.maxOutputTokens ?? null,
    })),
    segments,
    translationNotes: options.translationNotes ?? null,
  };
}

function normalizeSynthesisSegment(value: unknown): {
  segmentId: string;
  translation: string;
  selectedRunOrder: number | null;
  rationale: string | null;
} | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const segmentId = record.segmentId ?? record.segment_id;
  const translation = record.translation ?? record.translation_segment;
  if (typeof segmentId !== 'string' || typeof translation !== 'string') {
    return null;
  }
  const selectedRunOrder =
    typeof record.selectedRunOrder === 'number'
      ? record.selectedRunOrder
      : typeof record.selected_run_order === 'number'
        ? record.selected_run_order
        : null;
  const rationaleRaw = record.rationale ?? record.notes ?? record.commentary ?? null;
  const rationale =
    typeof rationaleRaw === 'string' && rationaleRaw.trim().length
      ? rationaleRaw.trim()
      : null;
  return {
    segmentId,
    translation,
    selectedRunOrder,
    rationale,
  };
}
