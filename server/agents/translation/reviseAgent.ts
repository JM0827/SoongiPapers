import { OpenAI } from 'openai';

import type { TranslationNotes } from '../../models/DocumentProfile';
import type { OriginSegment } from './segmentationAgent';
import type { TranslationDraftAgentSegmentResult } from './translationDraftAgent';
import { safeExtractOpenAIResponse } from '../../services/llm';
import { runResponsesWithRetry } from '../../services/openaiResponses';

import type { ResponseReasoningEffort, ResponseVerbosity } from './translationDraftAgent';

export interface TranslationReviseAgentOptions {
  projectId: string;
  jobId: string;
  sourceHash?: string;
  originSegments: OriginSegment[];
  draftSegments: TranslationDraftAgentSegmentResult[];
  translationNotes?: TranslationNotes | null;
  model?: string;
  verbosity?: ResponseVerbosity;
  reasoningEffort?: ResponseReasoningEffort;
  maxOutputTokens?: number;
}

export interface TranslationReviseSegmentResult {
  segment_id: string;
  revised_segment: string;
  span_pairs?: Array<{
    source_span_id: string;
    source_start: number;
    source_end: number;
    target_start: number;
    target_end: number;
  }>;
}

export interface TranslationReviseAgentResultMeta {
  verbosity: ResponseVerbosity;
  reasoningEffort: ResponseReasoningEffort;
  maxOutputTokens: number;
  attempts: number;
  retryCount: number;
  truncated: boolean;
  fallbackModelUsed: boolean;
}

export interface TranslationReviseAgentResult {
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  segments: TranslationReviseSegmentResult[];
  mergedText: string;
  meta: TranslationReviseAgentResultMeta;
  llm?: { runs: TranslationReviseLLMRunMeta[] };
}

export interface TranslationReviseLLMRunMeta {
  requestId: string | null;
  model: string;
  maxOutputTokens: number;
  attempts: number;
  truncated: boolean;
  verbosity: ResponseVerbosity;
  reasoningEffort: ResponseReasoningEffort;
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  };
}

const DEFAULT_REVISE_MODEL =
  process.env.TRANSLATION_REVISE_MODEL_V2?.trim() ||
  process.env.CHAT_MODEL?.trim() ||
  'gpt-5-mini';
const FALLBACK_REVISE_MODEL =
  process.env.TRANSLATION_REVISE_VALIDATION_MODEL_V2?.trim() ||
  'gpt-5-mini';
const DEFAULT_REVISE_VERBOSITY = normalizeVerbosity(
  process.env.TRANSLATION_REVISE_VERBOSITY_V2,
);
const DEFAULT_REVISE_REASONING_EFFORT = normalizeReasoningEffort(
  process.env.TRANSLATION_REVISE_REASONING_EFFORT_V2,
);
const DEFAULT_REVISE_MAX_OUTPUT_TOKENS = normalizePositiveInteger(
  process.env.TRANSLATION_REVISE_MAX_OUTPUT_TOKENS_V2,
  1400,
);
const REVISE_MAX_OUTPUT_TOKENS_CAP = normalizePositiveInteger(
  process.env.TRANSLATION_REVISE_MAX_OUTPUT_TOKENS_CAP_V2,
  3600,
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || '',
});

function isTranslationDebugEnabled(): boolean {
  const flag = process.env.TRANSLATION_V2_DEBUG;
  if (!flag) return false;
  const normalized = flag.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

const reviseResponseSchema = {
  name: 'translation_revise_segments',
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
            revision: { type: 'string' },
          },
          required: ['segmentId', 'revision'],
        },
      },
    },
  },
};

function normalizeVerbosity(value: string | undefined | null): ResponseVerbosity {
  if (!value) return 'medium';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high') {
    return normalized;
  }
  return 'medium';
}

function normalizeReasoningEffort(
  value: string | undefined | null,
): ResponseReasoningEffort {
  if (!value) return 'low';
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'minimal' ||
    normalized === 'low' ||
    normalized === 'medium' ||
    normalized === 'high'
  ) {
    return normalized as ResponseReasoningEffort;
  }
  return 'low';
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

export async function generateTranslationRevision(
  options: TranslationReviseAgentOptions,
): Promise<TranslationReviseAgentResult> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required for translation revise agent');
  }
  if (!options.originSegments?.length) {
    throw new Error('originSegments are required for translation revise agent');
  }
  if (!options.draftSegments?.length) {
    throw new Error('draftSegments are required for translation revise agent');
  }

  const baseModel = options.model?.trim() || DEFAULT_REVISE_MODEL;
  const fallbackModel = FALLBACK_REVISE_MODEL || baseModel;
  const baseVerbosity = options.verbosity || DEFAULT_REVISE_VERBOSITY;
  const baseEffort = options.reasoningEffort || DEFAULT_REVISE_REASONING_EFFORT;
  const baseMaxTokens = options.maxOutputTokens ?? DEFAULT_REVISE_MAX_OUTPUT_TOKENS;

  const systemPrompt = buildRevisePrompt(options.translationNotes ?? null);
  const userPayload = buildRevisePayload(options);

  const attempts = buildReviseAttemptConfigs(
    baseModel,
    fallbackModel,
    baseVerbosity,
    baseEffort,
  );

  const expectedIds = options.originSegments.map((segment) => segment.id);
  const attemptConfigs = attempts.length
    ? attempts
    : [
        {
          model: baseModel,
          verbosity: baseVerbosity,
          effort: baseEffort,
        },
      ];

  const resolveAttemptConfig = (
    attemptIndex: number,
  ): {
    model: string;
    verbosity: ResponseVerbosity;
    effort: ResponseReasoningEffort;
  } => {
    const boundedIndex = Math.min(
      Math.max(0, attemptIndex),
      Math.max(0, attemptConfigs.length - 1),
    );
    const baseConfig = attemptConfigs[boundedIndex];
    if (attemptIndex < attemptConfigs.length) {
      return baseConfig;
    }
    return {
      verbosity: 'low',
      effort: 'minimal',
      model: baseConfig.model,
    };
  };

  const runResult = await runResponsesWithRetry({
    client: openai,
    initialMaxOutputTokens: baseMaxTokens,
    maxOutputTokensCap: REVISE_MAX_OUTPUT_TOKENS_CAP,
    maxAttempts: Math.max(attemptConfigs.length + 2, 3),
    minOutputTokens: 200,
    onAttempt: ({ attemptIndex, maxOutputTokens: requestTokens }) => {
      if (!isTranslationDebugEnabled()) {
        return;
      }
      const attemptConfig = resolveAttemptConfig(attemptIndex);
      console.debug('[TRANSLATION] revise run attempt', {
        attempt: attemptIndex + 1,
        model: attemptConfig.model,
        verbosity: attemptConfig.verbosity,
        effort: attemptConfig.effort,
        maxOutputTokens: requestTokens,
      });
    },
    buildRequest: async ({ maxOutputTokens: requestTokens, attemptIndex }) => {
      const attemptConfig = resolveAttemptConfig(attemptIndex);
      try {
        return await openai.responses.create({
          model: attemptConfig.model,
          max_output_tokens: requestTokens,
          text: {
            format: {
              type: 'json_schema',
              name: reviseResponseSchema.name,
              schema: reviseResponseSchema.schema,
              strict: true,
            },
            verbosity: attemptConfig.verbosity,
          },
          reasoning: { effort: attemptConfig.effort },
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
                    'Revise the draft segments according to the rules. Return JSON matching the schema and nothing else.',
                },
              ],
            },
            {
              role: 'user',
              content: [{ type: 'input_text', text: JSON.stringify(userPayload) }],
            },
          ],
        });
      } catch (error) {
        if (isTranslationDebugEnabled()) {
          console.debug('[TRANSLATION] revise run attempt failed', {
            attempt: attemptIndex + 1,
            model: attemptConfig.model,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      }
    },
  });

  const { parsedJson, text: rawText, usage: responseUsage, requestId } =
    safeExtractOpenAIResponse(runResult.response);

  const payload = (parsedJson || (rawText ? JSON.parse(rawText) : null)) as
    | { segments?: Array<{ segmentId?: string; revision?: string }> }
    | null;

  if (!payload?.segments) {
    throw new Error('Revision response did not include any segments');
  }

  const hasAll = payload.segments.every((segment) =>
    typeof segment?.segmentId === 'string' && typeof segment?.revision === 'string',
  );
  if (!hasAll) {
    throw new Error('Revision response returned invalid segment entries');
  }

  const providedIds = new Set(payload.segments.map((segment) => segment.segmentId as string));
  const missing = expectedIds.filter((id) => !providedIds.has(id));
  if (missing.length) {
    throw new Error(
      `Revision response missing segments: ${missing.slice(0, 5).join(', ')}`,
    );
  }

  const parsedSegments = payload.segments.map((segment) => ({
    segmentId: segment.segmentId as string,
    revision: (segment.revision ?? '').toString(),
  }));

  const usage = {
    inputTokens: responseUsage?.prompt_tokens ?? 0,
    outputTokens: responseUsage?.completion_tokens ?? 0,
  };

  const finalAttemptIndex = Math.max(0, runResult.attempts - 1);
  const finalAttemptConfig = resolveAttemptConfig(finalAttemptIndex);
  const firstAttemptConfig = resolveAttemptConfig(0);

  if (isTranslationDebugEnabled()) {
    console.debug('[TRANSLATION] revise run success', {
      attempts: runResult.attempts,
      truncated: runResult.truncated,
      model: runResult.response.model ?? finalAttemptConfig.model,
      maxOutputTokens: runResult.maxOutputTokens,
    });
  }

  const llmRun: TranslationReviseLLMRunMeta = {
    requestId: requestId ?? runResult.response.id ?? null,
    model: runResult.response.model ?? finalAttemptConfig.model,
    maxOutputTokens: runResult.maxOutputTokens,
    attempts: runResult.attempts,
    truncated: runResult.truncated,
    verbosity: finalAttemptConfig.verbosity,
    reasoningEffort: finalAttemptConfig.effort,
    usage: {
      promptTokens: responseUsage?.prompt_tokens ?? null,
      completionTokens: responseUsage?.completion_tokens ?? null,
      totalTokens: responseUsage?.total_tokens ?? null,
    },
  };

  const draftMap = new Map(
    options.draftSegments.map((segment) => [segment.segment_id, segment]),
  );

  const orderedSegments: TranslationReviseSegmentResult[] = options.originSegments.map(
    (segment) => {
      const revisionEntry = parsedSegments.find((entry) => entry.segmentId === segment.id);
      const draft = draftMap.get(segment.id);
      const revision = (
        revisionEntry?.revision ?? draft?.translation_segment ?? segment.text
      ).trim();
      return {
        segment_id: segment.id,
        revised_segment: revision,
        span_pairs: [
          {
            source_span_id: segment.id,
            source_start: 0,
            source_end: segment.text.length,
            target_start: 0,
            target_end: revision.length,
          },
        ],
      } satisfies TranslationReviseSegmentResult;
    },
  );

  const mergedText = mergeSegmentsToText(options.originSegments, orderedSegments);
  return {
    model: runResult.response.model ?? finalAttemptConfig.model,
    usage,
    segments: orderedSegments,
    mergedText,
    meta: {
      verbosity: finalAttemptConfig.verbosity,
      reasoningEffort: finalAttemptConfig.effort,
      maxOutputTokens: runResult.maxOutputTokens,
      attempts: runResult.attempts,
      retryCount: Math.max(0, runResult.attempts - 1),
      truncated: runResult.truncated,
      fallbackModelUsed: finalAttemptConfig.model !== firstAttemptConfig.model,
    },
    llm: { runs: [llmRun] },
  };
}

function buildReviseAttemptConfigs(
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
      verbosity: 'low',
      effort: 'minimal',
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

function buildRevisePrompt(notes: TranslationNotes | null): string {
  const guideline = [
    'Preserve meaning and narrative voice; only adjust style, rhythm, clarity.',
    'Do not introduce new information or summarize.',
    'Keep metaphor, cultural references, and character voice intact.',
    'Use natural prose suitable for publication.',
    'Maintain paragraph alignment with the source segments.',
  ];
  if (notes?.timePeriod) {
    guideline.push(`Honor the historical/cultural context of ${notes.timePeriod}.`);
  }
  return [
    'You are the Revise agent polishing a draft translation.',
    'Given origin text + draft text for each segment, produce a refined version that preserves meaning but improves flow.',
    'Guidelines:',
    ...guideline.map((line) => `- ${line}`),
  ].join('\n');
}

function buildRevisePayload(options: TranslationReviseAgentOptions) {
  const draftMap = new Map(
    options.draftSegments.map((segment) => [segment.segment_id, segment]),
  );
  return {
    segments: options.originSegments.map((segment) => {
      const draft = draftMap.get(segment.id);
      return {
        segmentId: segment.id,
        origin: segment.text,
        draft: draft?.translation_segment ?? segment.text,
        notes: draft?.notes ?? [],
      };
    }),
  };
}

function mergeSegmentsToText(
  originSegments: OriginSegment[],
  revisedSegments: TranslationReviseSegmentResult[],
): string {
  const map = new Map(
    revisedSegments.map((entry) => [entry.segment_id, entry.revised_segment.trim()]),
  );
  return originSegments
    .map((origin, index) => {
      const revised = map.get(origin.id) ?? '';
      const previous = index > 0 ? originSegments[index - 1] : null;
      const needsBreak =
        previous && previous.paragraphIndex !== origin.paragraphIndex;
      const separator = index === 0 ? '' : needsBreak ? '\n\n' : '\n';
      return `${separator}${revised}`;
    })
    .join('')
    .trim();
}
