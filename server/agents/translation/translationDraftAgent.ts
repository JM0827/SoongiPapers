import { OpenAI } from 'openai';

import type { TranslationNotes } from '../../models/DocumentProfile';
import type { OriginSegment } from './segmentationAgent';
import { buildDraftSystemPrompt } from './promptBuilder';
import { safeExtractOpenAIResponse } from '../../services/llm';
import { runResponsesWithRetry } from '../../services/openaiResponses';

export type ResponseVerbosity = 'low' | 'medium' | 'high';
export type ResponseReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

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
  candidateCount?: number;
  deliberationModel?: string;
  projectTitle?: string | null;
  authorName?: string | null;
  synopsis?: string | null;
  register?: string | null;
  verbosity?: ResponseVerbosity;
  reasoningEffort?: ResponseReasoningEffort;
  maxOutputTokens?: number;
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

export interface TranslationDraftAgentResultMeta {
  verbosity: ResponseVerbosity;
  reasoningEffort: ResponseReasoningEffort;
  maxOutputTokens: number;
  attempts: number;
  retryCount: number;
  truncated: boolean;
  fallbackModelUsed: boolean;
}

export interface TranslationDraftAgentResult {
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  segments: TranslationDraftAgentSegmentResult[];
  mergedText: string;
  meta: TranslationDraftAgentResultMeta;
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
  meta: TranslationDraftAgentResultMeta;
}

const DEFAULT_TRANSLATION_MODEL =
  process.env.TRANSLATION_DRAFT_MODEL_V2?.trim() ||
  'gpt-5-mini';
const FALLBACK_TRANSLATION_MODEL =
  process.env.TRANSLATION_DRAFT_VALIDATION_MODEL_V2?.trim() ||
  'gpt-5-mini';
const DEFAULT_JUDGE_MODEL =
  process.env.TRANSLATION_DRAFT_JUDGE_MODEL_V2?.trim() ||
  FALLBACK_TRANSLATION_MODEL ||
  'gpt-5-mini';
const parsedCandidateEnv = Number(
  process.env.TRANSLATION_DRAFT_CANDIDATES ?? '1',
);
const DEFAULT_CANDIDATE_COUNT = Number.isFinite(parsedCandidateEnv)
  ? Math.max(1, Math.min(3, parsedCandidateEnv))
  : 1;
const DEFAULT_VERBOSITY = normalizeVerbosity(
  process.env.TRANSLATION_DRAFT_VERBOSITY_V2,
);
const DEFAULT_REASONING_EFFORT = normalizeReasoningEffort(
  process.env.TRANSLATION_DRAFT_REASONING_EFFORT_V2,
);
const DEFAULT_MAX_OUTPUT_TOKENS = normalizePositiveInteger(
  process.env.TRANSLATION_DRAFT_MAX_OUTPUT_TOKENS_V2,
  2200,
);
const MAX_OUTPUT_TOKENS_CAP = normalizePositiveInteger(
  process.env.TRANSLATION_DRAFT_MAX_OUTPUT_TOKENS_CAP_V2,
  6400,
);
const JUDGE_MAX_OUTPUT_TOKENS = normalizePositiveInteger(
  process.env.TRANSLATION_DRAFT_JUDGE_MAX_OUTPUT_TOKENS_V2,
  768,
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

interface DraftSegmentNormalized {
  segmentId: string;
  translation: string;
  notes: string[];
}

interface RawDraftResponse {
  segments?: unknown;
  commentary?: unknown;
}

const draftResponseSchema = {
  name: 'translation_draft_segments',
  schema: {
    type: 'object',
    required: ['segments', 'commentary'],
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
            notes: {
              type: 'array',
              items: { type: 'string' },
              default: [],
            },
          },
          required: ['segmentId', 'translation', 'notes'],
        },
      },
      commentary: { type: ['string', 'null'], default: null },
    },
  },
};

const deliberationResponseSchema = {
  name: 'draft_candidate_judgement',
  schema: {
    type: 'object',
    required: ['bestCandidateId', 'analysis', 'rationale'],
    additionalProperties: false,
    properties: {
      bestCandidateId: { type: 'string' },
      rationale: { type: ['string', 'null'], default: null },
      analysis: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            candidateId: { type: 'string' },
            summary: { type: 'string' },
            score: { type: ['number', 'null'], default: null },
          },
          required: ['candidateId', 'summary', 'score'],
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
  return 'low';
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

function coerceSegments(value: unknown): DraftSegmentNormalized[] | null {
  if (!value) return null;

  const visitQueue: unknown[] = [value];
  const seen = new Set<unknown>();

  while (visitQueue.length) {
    const current = visitQueue.shift();
    if (!current || typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);

    if (Array.isArray(current)) {
      const normalized = current
        .map((entry) => normalizeSegment(entry))
        .filter((entry): entry is DraftSegmentNormalized => entry !== null);
      if (normalized.length === current.length && normalized.length > 0) {
        return normalized;
      }
      visitQueue.push(...current);
      continue;
    }

    const record = current as Record<string, unknown>;
    if (record.segments) {
      const normalized = coerceSegments(record.segments);
      if (normalized) return normalized;
    }
    for (const entry of Object.values(record)) {
      if (entry && typeof entry === 'object') {
        visitQueue.push(entry);
      }
    }
  }

  return null;
}

function normalizeSegment(value: unknown): DraftSegmentNormalized | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const segmentId = record.segmentId ?? record.segment_id;
  const translation = record.translation ?? record.translation_segment;
  if (typeof segmentId !== 'string' || typeof translation !== 'string') {
    return null;
  }
  const notes = Array.isArray(record.notes)
    ? record.notes.filter((entry): entry is string => typeof entry === 'string')
    : [];
  return { segmentId, translation, notes };
}

function buildUserPromptPayload(options: TranslationDraftAgentOptions) {
  return {
    projectId: options.projectId,
    jobId: options.jobId,
    runOrder: options.runOrder,
    sourceHash: options.sourceHash,
    originLanguage: options.originLanguage ?? null,
    targetLanguage: options.targetLanguage ?? 'English',
    segments: options.originSegments.map((segment) => ({
      segmentId: segment.id,
      text: segment.text,
      paragraphIndex: segment.paragraphIndex,
      sentenceIndex: segment.sentenceIndex,
    })),
    translationNotes: options.translationNotes ?? null,
  };
}

function validateDraftResponse(
  response: RawDraftResponse,
  expectedIds: string[],
) {
  if (!response?.segments || !Array.isArray(response.segments)) {
    throw new Error('Draft response did not include any segments');
  }

  const providedIds = new Set(
    response.segments
      .map((segment) => normalizeSegment(segment))
      .filter((segment): segment is DraftSegmentNormalized => segment !== null)
      .map((segment) => segment.segmentId),
  );

  const missing = expectedIds.filter((id) => !providedIds.has(id));
  if (missing.length) {
    throw new Error(
      `Draft response missing segments: ${missing.slice(0, 5).join(', ')}`,
    );
  }
}

export async function generateTranslationDraft(
  options: TranslationDraftAgentOptions,
): Promise<TranslationDraftAgentResult> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required for translation draft agent');
  }
  if (!options.originSegments?.length) {
    throw new Error('originSegments are required for translation draft agent');
  }

  const baseModel = options.model?.trim() || DEFAULT_TRANSLATION_MODEL;
  const fallbackModel = FALLBACK_TRANSLATION_MODEL || baseModel;
  const baseVerbosity = options.verbosity || DEFAULT_VERBOSITY;
  const baseEffort = options.reasoningEffort || DEFAULT_REASONING_EFFORT;
  const baseMaxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

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

  const attemptsBase = buildDraftAttemptConfigs(
    baseModel,
    fallbackModel,
    baseVerbosity,
    baseEffort,
  );

  const candidates: DraftCandidate[] = [];
  let aggregateUsage = { inputTokens: 0, outputTokens: 0 };

  for (let index = 0; index < candidateCount; index += 1) {
    const candidate = await requestDraftCandidate({
      systemPrompt,
      userPayload,
      originSegments: options.originSegments,
      attempts: attemptsBase.map((attempt) => ({ ...attempt })),
      maxOutputTokens: baseMaxOutputTokens,
    });

    const candidateId = candidateCount === 1 ? 'candidate-1' : `candidate-${index + 1}`;
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
      model: options.deliberationModel?.trim() || DEFAULT_JUDGE_MODEL,
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
        text:
          candidateSegment?.translation_segment ?? segment.translation_segment,
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
    usage: aggregateUsage,
    segments: enrichedSegments,
    mergedText: selectedCandidate.mergedText,
    meta: selectedCandidate.meta,
  };
}

function buildDraftAttemptConfigs(
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

interface RequestCandidateParams {
  systemPrompt: string;
  userPayload: Record<string, unknown>;
  originSegments: OriginSegment[];
  attempts: Array<{
    model: string;
    verbosity: ResponseVerbosity;
    effort: ResponseReasoningEffort;
  }>;
  maxOutputTokens: number;
}

async function requestDraftCandidate(
  params: RequestCandidateParams,
): Promise<{
  segments: TranslationDraftAgentSegmentResult[];
  mergedText: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  meta: TranslationDraftAgentResultMeta;
}> {
  const { systemPrompt, userPayload, originSegments, attempts, maxOutputTokens } = params;

  const expectedIds = originSegments.map((segment) => segment.id);
  const attemptConfigs = attempts.length
    ? attempts
    : [
        {
          model: DEFAULT_TRANSLATION_MODEL,
          verbosity: 'medium' as ResponseVerbosity,
          effort: 'medium' as ResponseReasoningEffort,
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
    initialMaxOutputTokens: maxOutputTokens,
    maxOutputTokensCap: MAX_OUTPUT_TOKENS_CAP,
    maxAttempts: Math.max(attemptConfigs.length + 2, 3),
    minOutputTokens: 200,
    onAttempt: ({ attemptIndex, maxOutputTokens: requestTokens }) => {
      if (!isTranslationDebugEnabled()) {
        return;
      }
      const attemptConfig = resolveAttemptConfig(attemptIndex);
      console.debug('[TRANSLATION] draft run attempt', {
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
              name: draftResponseSchema.name,
              schema: draftResponseSchema.schema,
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
                    'Translate each segment faithfully. Return JSON matching the schema. Do not add commentary or additional fields.',
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
          console.debug('[TRANSLATION] draft run attempt failed', {
            attempt: attemptIndex + 1,
            model: attemptConfig.model,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      }
    },
  });

  const { parsedJson, text: rawText, usage: responseUsage } = safeExtractOpenAIResponse(
    runResult.response,
  );

  let payload: RawDraftResponse | null = null;
  if (parsedJson && typeof parsedJson === 'object') {
    payload = parsedJson as RawDraftResponse;
  } else if (rawText && rawText.trim().length) {
    payload = JSON.parse(rawText) as RawDraftResponse;
  }

  if (!payload) {
    throw new Error('Draft response returned empty payload');
  }

  validateDraftResponse(payload, expectedIds);

  const usage = {
    inputTokens: responseUsage?.prompt_tokens ?? 0,
    outputTokens: responseUsage?.completion_tokens ?? 0,
  };

  const normalizedSegments = (Array.isArray(payload.segments) ? payload.segments : [])
    .map((entry) => normalizeSegment(entry))
    .filter((entry): entry is DraftSegmentNormalized => entry !== null)
    .map((segment) => {
      const origin = originSegments.find((item) => item.id === segment.segmentId);
      const originalText = origin?.text ?? '';
      const translation = segment.translation.trim();
      const safeTranslation = translation.length ? translation : originalText;
      return {
        segment_id: segment.segmentId,
        origin_segment: originalText,
        translation_segment: safeTranslation,
        notes: segment.notes,
        spanPairs: buildSpanPairs(segment.segmentId, originalText, safeTranslation),
      } satisfies TranslationDraftAgentSegmentResult;
    });

  const mergedText = mergeSegmentsToText(originSegments, normalizedSegments);
  const finalAttemptIndex = Math.max(0, runResult.attempts - 1);
  const finalAttemptConfig = resolveAttemptConfig(finalAttemptIndex);
  const rootAttemptConfig = resolveAttemptConfig(0);

  if (isTranslationDebugEnabled()) {
    console.debug('[TRANSLATION] draft run success', {
      attempts: runResult.attempts,
      truncated: runResult.truncated,
      model: runResult.response.model ?? finalAttemptConfig.model,
      maxOutputTokens: runResult.maxOutputTokens,
    });
  }

  return {
    segments: normalizedSegments,
    mergedText,
    model: runResult.response.model || finalAttemptConfig.model,
    usage,
    meta: {
      verbosity: finalAttemptConfig.verbosity,
      reasoningEffort: finalAttemptConfig.effort,
      maxOutputTokens: runResult.maxOutputTokens,
      attempts: runResult.attempts,
      retryCount: Math.max(0, runResult.attempts - 1),
      truncated: runResult.truncated,
      fallbackModelUsed: finalAttemptConfig.model !== rootAttemptConfig.model,
    },
  };
}

function mergeSegmentsToText(
  originSegments: OriginSegment[],
  translatedSegments: TranslationDraftAgentSegmentResult[],
): string {
  return originSegments
    .map((originSegment, index) => {
      const translated =
        translatedSegments[index]?.translation_segment?.trim() ?? '';
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
  rationale?: string | null;
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
  const {
    candidates,
    originSegments,
    sourceLanguage,
    targetLanguage,
    translationNotes,
    model,
  } = params;

  if (!candidates.length) {
    return null;
  }

  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  try {
    const inputPayload = {
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
    };

    const response = await openai.responses.create({
      model,
      max_output_tokens: JUDGE_MAX_OUTPUT_TOKENS,
      text: {
        format: {
          type: 'json_schema',
          name: deliberationResponseSchema.name,
          schema: deliberationResponseSchema.schema,
          strict: true,
        },
        verbosity: 'low',
      },
      reasoning: { effort: 'minimal' },
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text:
                'You are an expert literary translation evaluator. Choose the candidate that best preserves meaning, glossary, and contractual tone. Respond with JSON only.',
            },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'input_text', text: JSON.stringify(inputPayload) }],
        },
      ],
    });

    const { parsedJson, text, usage } = safeExtractOpenAIResponse(response);
    const payload = (parsedJson || (text ? JSON.parse(text) : null)) as
      | {
          bestCandidateId?: string;
          rationale?: string | null;
          analysis?: Array<{ candidateId: string; summary: string; score?: number }>;
        }
      | null;

    if (!payload) {
      return null;
    }

    return {
      bestCandidateId: payload.bestCandidateId ?? candidates[0].id,
      rationale: payload.rationale ?? null,
      analysis: payload.analysis ?? [],
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
      },
    };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[TRANSLATION] Candidate deliberation failed', {
      error,
    });
    return null;
  }
}
