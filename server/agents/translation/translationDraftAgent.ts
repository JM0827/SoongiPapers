import { OpenAI } from "openai";
import type { Response } from "openai/resources/responses/responses";

import type { TranslationNotes } from "../../models/DocumentProfile";
import type { OriginSegment } from "./segmentationAgent";
import { buildDraftSystemPrompt } from "./promptBuilder";
import { safeExtractOpenAIResponse } from "../../services/llm";
import {
  runResponsesWithRetry,
  type ResponsesRetryAttemptContext,
} from "../../services/openaiResponses";
import {
  mergeAgentMeta,
  mergeDraftSegmentResults,
  splitOriginSegmentForRetry,
} from "./segmentRetryHelpers";

export type ResponseVerbosity = "low" | "medium" | "high";
export type ResponseReasoningEffort = "minimal" | "low" | "medium" | "high";

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
  allowSegmentRetry?: boolean;
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
  jsonRepairApplied: boolean;
  attemptHistory: ResponsesRetryAttemptContext[];
  downshiftCount?: number;
  forcedPaginationCount?: number;
  cursorRetryCount?: number;
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
  process.env.TRANSLATION_DRAFT_MODEL_V2?.trim() || "gpt-5-mini";
const FALLBACK_TRANSLATION_MODEL =
  process.env.TRANSLATION_DRAFT_VALIDATION_MODEL_V2?.trim() || "gpt-5-mini";
const DEFAULT_JUDGE_MODEL =
  process.env.TRANSLATION_DRAFT_JUDGE_MODEL_V2?.trim() ||
  FALLBACK_TRANSLATION_MODEL ||
  "gpt-5-mini";
const parsedCandidateEnv = Number(
  process.env.TRANSLATION_DRAFT_CANDIDATES ?? "1",
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
  apiKey: process.env.OPENAI_API_KEY || "",
});

function isTranslationDebugEnabled(): boolean {
  const flag = process.env.TRANSLATION_V2_DEBUG;
  if (!flag) return false;
  const normalized = flag.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
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
  name: "translation_draft_segments",
  schema: {
    type: "object",
    required: ["segments", "commentary"],
    additionalProperties: false,
    properties: {
      segments: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            segmentId: { type: "string" },
            translation: { type: "string" },
            notes: {
              type: "array",
              items: { type: "string" },
              default: [],
            },
          },
          required: ["segmentId", "translation", "notes"],
        },
      },
      commentary: { type: ["string", "null"], default: null },
    },
  },
};

const deliberationResponseSchema = {
  name: "draft_candidate_judgement",
  schema: {
    type: "object",
    required: ["bestCandidateId", "analysis", "rationale"],
    additionalProperties: false,
    properties: {
      bestCandidateId: { type: "string" },
      rationale: { type: ["string", "null"], default: null },
      analysis: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            candidateId: { type: "string" },
            summary: { type: "string" },
            score: { type: ["number", "null"], default: null },
          },
          required: ["candidateId", "summary", "score"],
        },
      },
    },
  },
};

function normalizeVerbosity(
  value: string | undefined | null,
): ResponseVerbosity {
  if (!value) return "medium";
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high"
  ) {
    return normalized;
  }
  return "low";
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
  return "low";
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

function normalizeSegment(value: unknown): DraftSegmentNormalized | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const segmentId = record.segmentId ?? record.segment_id;
  const translation = record.translation ?? record.translation_segment;
  if (typeof segmentId !== "string" || typeof translation !== "string") {
    return null;
  }
  const notes = Array.isArray(record.notes)
    ? record.notes.filter((entry): entry is string => typeof entry === "string")
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
    targetLanguage: options.targetLanguage ?? "English",
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
    throw new Error("Draft response did not include any segments");
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

  const baseModel = options.model?.trim() || DEFAULT_TRANSLATION_MODEL;
  const fallbackModel = FALLBACK_TRANSLATION_MODEL || baseModel;
  const baseVerbosity = options.verbosity || DEFAULT_VERBOSITY;
  const baseEffort = options.reasoningEffort || DEFAULT_REASONING_EFFORT;
  const baseMaxOutputTokens =
    options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

  const systemPrompt = buildDraftSystemPrompt({
    projectTitle: options.projectTitle ?? null,
    authorName: options.authorName ?? null,
    synopsis: options.synopsis ?? null,
    register: options.register ?? null,
    sourceLanguage: options.originLanguage ?? null,
    targetLanguage: options.targetLanguage ?? null,
    translationNotes: options.translationNotes ?? null,
  });

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
  const aggregateUsage = { inputTokens: 0, outputTokens: 0 };

  for (let index = 0; index < candidateCount; index += 1) {
    const candidate = await requestDraftCandidate({
      systemPrompt,
      baseOptions: options,
      originSegments: options.originSegments,
      attempts: attemptsBase.map((attempt) => ({ ...attempt })),
      maxOutputTokens: baseMaxOutputTokens,
      allowSegmentRetry: options.allowSegmentRetry ?? true,
    });

    const candidateId =
      candidateCount === 1 ? "candidate-1" : `candidate-${index + 1}`;
    candidates.push({
      id: candidateId,
      ...candidate,
    });
    aggregateUsage.inputTokens += candidate.usage.inputTokens;
    aggregateUsage.outputTokens += candidate.usage.outputTokens;
  }

  let selectedCandidate = candidates[0];
  const candidateAnalyses: Record<string, { summary: string; score?: number }> =
    {};

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

  const candidateSegmentMap = new Map<
    string,
    Map<string, TranslationDraftAgentSegmentResult>
  >();
  candidates.forEach((candidate) => {
    candidateSegmentMap.set(
      candidate.id,
      new Map(
        candidate.segments.map((segment) => [segment.segment_id, segment]),
      ),
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
      verbosity: "low",
      effort: "minimal",
    },
  ];

  if (fallbackModel && fallbackModel !== baseModel) {
    attempts.push({
      model: fallbackModel,
      verbosity: "low",
      effort: "minimal",
    });
  }

  return attempts;
}

interface RequestCandidateParams {
  systemPrompt: string;
  baseOptions: TranslationDraftAgentOptions;
  originSegments: OriginSegment[];
  attempts: Array<{
    model: string;
    verbosity: ResponseVerbosity;
    effort: ResponseReasoningEffort;
  }>;
  maxOutputTokens: number;
  allowSegmentRetry?: boolean;
}

async function requestDraftCandidate(params: RequestCandidateParams): Promise<{
  segments: TranslationDraftAgentSegmentResult[];
  mergedText: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  meta: TranslationDraftAgentResultMeta;
}> {
  const {
    systemPrompt,
    baseOptions,
    originSegments,
    attempts,
    maxOutputTokens,
    allowSegmentRetry = true,
  } = params;

  const payloadOptions: TranslationDraftAgentOptions = {
    ...baseOptions,
    originSegments,
  };
  const userPayload = buildUserPromptPayload(payloadOptions);

  const expectedIds = originSegments.map((segment) => segment.id);
  const attemptConfigs = attempts.length
    ? attempts
    : [
        {
          model: DEFAULT_TRANSLATION_MODEL,
          verbosity: "medium" as ResponseVerbosity,
          effort: "medium" as ResponseReasoningEffort,
        },
      ];

  const fallbackAttemptConfig =
    attemptConfigs.length > 1 &&
    attemptConfigs[attemptConfigs.length - 1].model !== attemptConfigs[0].model
      ? attemptConfigs[attemptConfigs.length - 1]
      : null;

  const primaryAttemptConfigs = fallbackAttemptConfig
    ? attemptConfigs.slice(0, Math.max(1, attemptConfigs.length - 1))
    : attemptConfigs;

  const canSegmentRetry = allowSegmentRetry && originSegments.length > 1;
  let segmentRetrySegments: TranslationDraftAgentSegmentResult[] | null = null;
  let segmentRetryUsage: { inputTokens: number; outputTokens: number } | null = null;
  let segmentRetryMeta: TranslationDraftAgentResultMeta | null = null;
  let segmentRetryModel: string | null = null;

  const pickPrimaryAttemptConfig = (
    attemptIndex: number,
  ): {
    model: string;
    verbosity: ResponseVerbosity;
    effort: ResponseReasoningEffort;
  } => {
    if (!primaryAttemptConfigs.length) {
      return fallbackAttemptConfig ?? attemptConfigs[0];
    }
    const boundedIndex = Math.min(
      Math.max(0, attemptIndex),
      primaryAttemptConfigs.length - 1,
    );
    return primaryAttemptConfigs[boundedIndex];
  };

  const describeAttempt = (
    context: ResponsesRetryAttemptContext,
    config: { model: string; verbosity: ResponseVerbosity; effort: ResponseReasoningEffort },
  ) => ({
    attempt: context.attemptIndex + 1,
    model: config.model,
    verbosity: config.verbosity,
    effort: config.effort,
    maxOutputTokens: context.maxOutputTokens,
    stage: context.stage,
    reason: context.reason,
    usingFallback: context.usingFallback,
    usingSegmentRetry: context.usingSegmentRetry,
  });

  const executeRequest = async (
    context: ResponsesRetryAttemptContext,
    config: { model: string; verbosity: ResponseVerbosity; effort: ResponseReasoningEffort },
  ) => {
    try {
      return await openai.responses.create({
        model: config.model,
        max_output_tokens: context.maxOutputTokens,
        text: {
          format: {
            type: "json_schema",
            name: draftResponseSchema.name,
            schema: draftResponseSchema.schema,
            strict: true,
          },
          verbosity: config.verbosity,
        },
        reasoning: { effort: config.effort },
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: systemPrompt }],
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Translate each segment faithfully. Return JSON matching the schema. Do not add commentary or additional fields.",
              },
            ],
          },
          {
            role: "user",
            content: [{ type: "input_text", text: JSON.stringify(userPayload) }],
          },
        ],
      });
    } catch (error) {
      if (isTranslationDebugEnabled()) {
        console.debug("[TRANSLATION] draft run attempt failed", {
          ...describeAttempt(context, config),
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  };

  const buildSyntheticResponse = (
    aggregate: TranslationDraftAgentResult,
  ): Response => {
    const normalized = aggregate.segments.map((segment) => ({
      segmentId: segment.segment_id,
      translation: segment.translation_segment,
      notes: segment.notes ?? [],
    }));
    const payload = { segments: normalized, commentary: null };
    const payloadText = JSON.stringify(payload);
    return {
      id: `segment-retry-${Date.now().toString(16)}`,
      status: "completed",
      model: aggregate.model,
      output_text: payloadText,
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: payloadText },
            { type: "output_parsed", parsed_json: payload },
          ],
        },
      ],
      usage: {
        prompt_tokens: aggregate.usage.inputTokens,
        completion_tokens: aggregate.usage.outputTokens,
        total_tokens:
          aggregate.usage.inputTokens + aggregate.usage.outputTokens,
      },
    } as unknown as Response;
  };

  const draftSegmentsWithSplit = async (
    segmentsToProcess: OriginSegment[],
    context: ResponsesRetryAttemptContext,
  ): Promise<TranslationDraftAgentResult | null> => {
    if (!segmentsToProcess.length) return null;

    if (segmentsToProcess.length <= 1) {
      const original = segmentsToProcess[0];
      const subdivisions = splitOriginSegmentForRetry(original);
      if (subdivisions.length <= 1) {
        return null;
      }

      const partialResults: TranslationDraftAgentResult[] = [];
      for (const subdivision of subdivisions) {
        const subsetOptions: TranslationDraftAgentOptions = {
          ...baseOptions,
          originSegments: [subdivision],
          candidateCount: 1,
          allowSegmentRetry,
          maxOutputTokens,
        };
        const subset = await requestDraftCandidate({
          systemPrompt,
          baseOptions: subsetOptions,
          originSegments: [subdivision],
          attempts: attempts.map((attempt) => ({ ...attempt })),
          maxOutputTokens: context.maxOutputTokens,
          allowSegmentRetry,
        });
        partialResults.push(subset);
      }

      const combinedUsage = partialResults.reduce(
        (acc, current) => ({
          inputTokens: acc.inputTokens + current.usage.inputTokens,
          outputTokens: acc.outputTokens + current.usage.outputTokens,
        }),
        { inputTokens: 0, outputTokens: 0 },
      );

      let combinedMeta = partialResults[0].meta;
      for (let index = 1; index < partialResults.length; index += 1) {
        combinedMeta = mergeAgentMeta(combinedMeta, partialResults[index].meta);
      }
      combinedMeta.truncated = false;
      combinedMeta.attemptHistory = [
        ...(combinedMeta.attemptHistory ?? []),
        context,
      ];

      const mergedSegment = mergeDraftSegmentResults(
        original,
        partialResults.flatMap((result) => result.segments),
      );

      return {
        segments: [mergedSegment],
        mergedText: mergedSegment.translation_segment,
        usage: combinedUsage,
        meta: combinedMeta,
        model: partialResults[0].model,
      } satisfies TranslationDraftAgentResult;
    }

    const midpoint = Math.max(1, Math.floor(segmentsToProcess.length / 2));
    const leftSegments = segmentsToProcess.slice(0, midpoint);
    const rightSegments = segmentsToProcess.slice(midpoint);

    const leftOptions: TranslationDraftAgentOptions = {
      ...baseOptions,
      originSegments: leftSegments,
      candidateCount: 1,
      allowSegmentRetry,
      maxOutputTokens,
    };
    const rightOptions: TranslationDraftAgentOptions = {
      ...baseOptions,
      originSegments: rightSegments,
      candidateCount: 1,
      allowSegmentRetry,
      maxOutputTokens,
    };

    const leftResult = await requestDraftCandidate({
      systemPrompt,
      baseOptions: leftOptions,
      originSegments: leftSegments,
      attempts: attempts.map((attempt) => ({ ...attempt })),
      maxOutputTokens: context.maxOutputTokens,
      allowSegmentRetry,
    });
    const rightResult = await requestDraftCandidate({
      systemPrompt,
      baseOptions: rightOptions,
      originSegments: rightSegments,
      attempts: attempts.map((attempt) => ({ ...attempt })),
      maxOutputTokens: context.maxOutputTokens,
      allowSegmentRetry,
    });

    const combinedUsage = {
      inputTokens:
        leftResult.usage.inputTokens + rightResult.usage.inputTokens,
      outputTokens:
        leftResult.usage.outputTokens + rightResult.usage.outputTokens,
    };

    const combinedMeta = mergeAgentMeta(leftResult.meta, rightResult.meta);
    combinedMeta.truncated = false;
    combinedMeta.attemptHistory = [
      ...(combinedMeta.attemptHistory ?? []),
      context,
    ];

    const mergedSegments = [...leftResult.segments, ...rightResult.segments];
    const mergedText = mergeSegmentsToText(
      [...leftSegments, ...rightSegments],
      mergedSegments,
    );

    return {
      segments: mergedSegments,
      mergedText,
      usage: combinedUsage,
      meta: combinedMeta,
      model: leftResult.model,
    } satisfies TranslationDraftAgentResult;
  };

  segmentRetrySegments = null;
  segmentRetryUsage = null;
  segmentRetryMeta = null;
  segmentRetryModel = null;
  let downshiftCount = 0;
  let forcedPaginationCount = 0;
  let cursorRetryCount = 0;
  const runResult = await runResponsesWithRetry<Response>({
    client: openai,
    initialMaxOutputTokens: maxOutputTokens,
    maxOutputTokensCap: MAX_OUTPUT_TOKENS_CAP,
    maxAttempts: Math.max(attemptConfigs.length + 2, 3),
    minOutputTokens: 200,
    onAttempt: ({
      attemptIndex,
      maxOutputTokens: requestTokens,
      stage,
      reason,
      usingFallback,
      usingSegmentRetry,
    }) => {
      if (stage === "downshift" || stage === "minimal") {
        downshiftCount += 1;
      }
      if (reason === "segment_retry") {
        cursorRetryCount += 1;
      }
      if (reason === "incomplete" && stage === "segment") {
        forcedPaginationCount += 1;
      }
      if (!isTranslationDebugEnabled()) {
        return;
      }
      const attemptContext: ResponsesRetryAttemptContext = {
        attemptIndex,
        maxOutputTokens: requestTokens,
        stage,
        reason,
        usingFallback,
        usingSegmentRetry,
      };
      const attemptConfig = usingFallback && fallbackAttemptConfig
        ? fallbackAttemptConfig
        : pickPrimaryAttemptConfig(attemptIndex);
      console.debug("[TRANSLATION] draft run attempt", {
        ...describeAttempt(attemptContext, attemptConfig),
      });
    },
    buildRequest: async (context) =>
      executeRequest(context, pickPrimaryAttemptConfig(context.attemptIndex)),
    buildFallbackRequest: fallbackAttemptConfig
      ? async (context) => executeRequest(context, fallbackAttemptConfig)
      : undefined,
    retrySegmentFn: canSegmentRetry
      ? async (context) => {
          const aggregate = await draftSegmentsWithSplit(
            originSegments,
            context,
          );
          if (!aggregate) {
            return null;
          }
          segmentRetrySegments = aggregate.segments;
          segmentRetryUsage = aggregate.usage;
          segmentRetryMeta = aggregate.meta;
          segmentRetryModel = aggregate.model;
          return buildSyntheticResponse(aggregate);
        }
      : undefined,
  });

  const {
    parsedJson,
    usage: responseUsage,
    repairApplied,
  } = safeExtractOpenAIResponse(runResult.response);

  if (!parsedJson || typeof parsedJson !== "object") {
    throw new Error("Draft response returned empty payload");
  }

  const payload = parsedJson as RawDraftResponse;

  validateDraftResponse(payload, expectedIds);

  const baseUsage = {
    inputTokens: responseUsage?.prompt_tokens ?? 0,
    outputTokens: responseUsage?.completion_tokens ?? 0,
  };

  const extractedSegments = (
    Array.isArray(payload.segments) ? payload.segments : []
  )
    .map((entry) => normalizeSegment(entry))
    .filter((entry): entry is DraftSegmentNormalized => entry !== null)
    .map((segment) => {
      const origin = originSegments.find(
        (item) => item.id === segment.segmentId,
      );
      const originalText = origin?.text ?? "";
      const translation = segment.translation.trim();
      const safeTranslation = translation.length ? translation : originalText;
      return {
        segment_id: segment.segmentId,
        origin_segment: originalText,
        translation_segment: safeTranslation,
        notes: segment.notes,
        spanPairs: buildSpanPairs(
          segment.segmentId,
          originalText,
          safeTranslation,
        ),
      } satisfies TranslationDraftAgentSegmentResult;
    });

  const retrySegments = segmentRetrySegments as
    | TranslationDraftAgentSegmentResult[]
    | null;
  const retryUsage = segmentRetryUsage as
    | { inputTokens: number; outputTokens: number }
    | null;
  const retryMeta = segmentRetryMeta as TranslationDraftAgentResultMeta | null;
  const retryModel = segmentRetryModel as string | null;

  const finalSegments = retrySegments ?? extractedSegments;

  const usage = retryUsage ? { ...retryUsage } : baseUsage;

  const mergedText = mergeSegmentsToText(originSegments, finalSegments);
  const lastAttemptContext =
    runResult.attemptHistory[runResult.attemptHistory.length - 1] ?? null;
  const finalAttemptConfig = lastAttemptContext
    ? lastAttemptContext.usingFallback && fallbackAttemptConfig
      ? fallbackAttemptConfig
      : pickPrimaryAttemptConfig(lastAttemptContext.attemptIndex)
    : pickPrimaryAttemptConfig(runResult.attempts - 1);
  const rootAttemptConfig = pickPrimaryAttemptConfig(0);
  let fallbackModelUsed =
    Boolean(lastAttemptContext?.usingFallback) ||
    finalAttemptConfig.model !== rootAttemptConfig.model;

  const segmentMeta = retryMeta;
  const segmentAttempts = segmentMeta?.attempts ?? 0;
  const totalAttempts = runResult.attempts + segmentAttempts;
  downshiftCount += segmentMeta?.downshiftCount ?? 0;
  forcedPaginationCount += segmentMeta?.forcedPaginationCount ?? 0;
  cursorRetryCount += segmentMeta?.cursorRetryCount ?? 0;
  let attemptHistory = [...runResult.attemptHistory];
  if (segmentMeta?.attemptHistory?.length) {
    attemptHistory = attemptHistory.concat(segmentMeta.attemptHistory);
  }

  fallbackModelUsed = fallbackModelUsed || Boolean(segmentMeta?.fallbackModelUsed);
  const jsonRepairFlag = Boolean(repairApplied) || Boolean(segmentMeta?.jsonRepairApplied);
  const truncatedFlag = retrySegments ? false : runResult.truncated;
  const maxTokensUsed = Math.max(
    runResult.maxOutputTokens,
    segmentMeta?.maxOutputTokens ?? runResult.maxOutputTokens,
  );

  const responseModel = runResult.response.model ?? null;

  if (isTranslationDebugEnabled()) {
    console.debug("[TRANSLATION] draft run success", {
      attempts: totalAttempts,
      truncated: truncatedFlag,
      model:
        retryModel ??
        responseModel ??
        finalAttemptConfig.model,
      maxOutputTokens: maxTokensUsed,
    });
  }

  return {
    segments: finalSegments,
    mergedText,
    model:
      retryModel ??
      responseModel ??
      finalAttemptConfig.model,
    usage,
    meta: {
      verbosity: finalAttemptConfig.verbosity,
      reasoningEffort: finalAttemptConfig.effort,
      maxOutputTokens: maxTokensUsed,
      attempts: totalAttempts,
      retryCount: Math.max(0, totalAttempts - 1),
      truncated: truncatedFlag,
      fallbackModelUsed,
      jsonRepairApplied: jsonRepairFlag,
      attemptHistory,
      downshiftCount,
      forcedPaginationCount,
      cursorRetryCount,
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
        translatedSegments[index]?.translation_segment?.trim() ?? "";
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
          type: "json_schema",
          name: deliberationResponseSchema.name,
          schema: deliberationResponseSchema.schema,
          strict: true,
        },
        verbosity: "low",
      },
      reasoning: { effort: "minimal" },
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: "You are an expert literary translation evaluator. Choose the candidate that best preserves meaning, glossary, and contractual tone. Respond with JSON only.",
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: JSON.stringify(inputPayload) }],
        },
      ],
    });

    const { parsedJson, usage } = safeExtractOpenAIResponse(response);
    if (!parsedJson || typeof parsedJson !== "object") {
      return null;
    }

    const payload = parsedJson as {
      bestCandidateId?: string;
      rationale?: string | null;
      analysis?: Array<{
        candidateId: string;
        summary: string;
        score?: number;
      }>;
    };

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
    console.warn("[TRANSLATION] Candidate deliberation failed", {
      error,
    });
    return null;
  }
}
