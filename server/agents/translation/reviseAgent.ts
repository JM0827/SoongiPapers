import { OpenAI } from "openai";
import type { Response } from "openai/resources/responses/responses";

import type { TranslationNotes } from "../../models/DocumentProfile";
import type { OriginSegment } from "./segmentationAgent";
import type { TranslationDraftAgentSegmentResult } from "./translationDraftAgent";
import { safeExtractOpenAIResponse } from "../../services/llm";
import {
  runResponsesWithRetry,
  type ResponsesRetryAttemptContext,
} from "../../services/openaiResponses";
import { mergeAgentMeta } from "./segmentRetryHelpers";

import type {
  ResponseReasoningEffort,
  ResponseVerbosity,
} from "./translationDraftAgent";

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
  allowSegmentRetry?: boolean;
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
  jsonRepairApplied: boolean;
  attemptHistory: ResponsesRetryAttemptContext[];
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
  "gpt-5-mini";
const FALLBACK_REVISE_MODEL =
  process.env.TRANSLATION_REVISE_VALIDATION_MODEL_V2?.trim() || "gpt-5-mini";
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
  apiKey: process.env.OPENAI_API_KEY || "",
});

function isTranslationDebugEnabled(): boolean {
  const flag = process.env.TRANSLATION_V2_DEBUG;
  if (!flag) return false;
  const normalized = flag.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

const reviseResponseSchema = {
  name: "translation_revise_segments",
  schema: {
    type: "object",
    required: ["segments"],
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
            revision: { type: "string" },
          },
          required: ["segmentId", "revision"],
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
  return "medium";
}

function normalizeReasoningEffort(
  value: string | undefined | null,
): ResponseReasoningEffort {
  if (!value) return "low";
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high"
  ) {
    return normalized as ResponseReasoningEffort;
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

export async function generateTranslationRevision(
  options: TranslationReviseAgentOptions,
): Promise<TranslationReviseAgentResult> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for translation revise agent");
  }
  if (!options.originSegments?.length) {
    throw new Error("originSegments are required for translation revise agent");
  }
  if (!options.draftSegments?.length) {
    throw new Error("draftSegments are required for translation revise agent");
  }

  const baseModel = options.model?.trim() || DEFAULT_REVISE_MODEL;
  const fallbackModel = FALLBACK_REVISE_MODEL || baseModel;
  const baseVerbosity = options.verbosity || DEFAULT_REVISE_VERBOSITY;
  const baseEffort = options.reasoningEffort || DEFAULT_REVISE_REASONING_EFFORT;
  const baseMaxTokens =
    options.maxOutputTokens ?? DEFAULT_REVISE_MAX_OUTPUT_TOKENS;

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

  const fallbackAttemptConfig =
    attemptConfigs.length > 1 &&
    attemptConfigs[attemptConfigs.length - 1].model !== attemptConfigs[0].model
      ? attemptConfigs[attemptConfigs.length - 1]
      : null;

  const primaryAttemptConfigs = fallbackAttemptConfig
    ? attemptConfigs.slice(0, Math.max(1, attemptConfigs.length - 1))
    : attemptConfigs;

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

  const canSegmentRetry =
    (options.allowSegmentRetry ?? true) && options.originSegments.length > 1;

  const draftSegmentMap = new Map(
    options.draftSegments.map((segment) => [segment.segment_id, segment]),
  );

  const filterDraftSegments = (subset: OriginSegment[]) =>
    subset
      .map((segment) => draftSegmentMap.get(segment.id))
      .filter((segment): segment is TranslationDraftAgentSegmentResult =>
        Boolean(segment),
      );

  let segmentRetrySegments: TranslationReviseSegmentResult[] | null = null;
  let segmentRetryUsage: { inputTokens: number; outputTokens: number } | null = null;
  let segmentRetryMeta: TranslationReviseAgentResultMeta | null = null;
  let segmentRetryModel: string | null = null;
  let segmentRetryRuns: TranslationReviseLLMRunMeta[] | null = null;

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
            name: reviseResponseSchema.name,
            schema: reviseResponseSchema.schema,
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
                text: "Revise the draft segments according to the rules. Return JSON matching the schema and nothing else.",
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
        console.debug("[TRANSLATION] revise run attempt failed", {
          ...describeAttempt(context, config),
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  };

  const buildSyntheticResponse = (
    aggregate: TranslationReviseAgentResult,
  ): Response => {
    const normalized = aggregate.segments.map((segment) => ({
      segmentId: segment.segment_id,
      revision: segment.revised_segment,
    }));
    const payload = { segments: normalized };
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

  const reviseSegmentsWithSplit = async (
    segmentsToProcess: OriginSegment[],
    context: ResponsesRetryAttemptContext,
  ): Promise<TranslationReviseAgentResult | null> => {
    if (!segmentsToProcess.length) return null;
    if (segmentsToProcess.length <= 1) {
      return null;
    }

    const midpoint = Math.max(1, Math.floor(segmentsToProcess.length / 2));
    const leftSegments = segmentsToProcess.slice(0, midpoint);
    const rightSegments = segmentsToProcess.slice(midpoint);

    const leftDraftSegments = filterDraftSegments(leftSegments);
    const rightDraftSegments = filterDraftSegments(rightSegments);

    if (leftDraftSegments.length !== leftSegments.length) {
      return null;
    }
    if (rightDraftSegments.length !== rightSegments.length) {
      return null;
    }

    const leftOptions: TranslationReviseAgentOptions = {
      ...options,
      originSegments: leftSegments,
      draftSegments: leftDraftSegments,
      allowSegmentRetry: false,
      maxOutputTokens: context.maxOutputTokens,
    };

    const rightOptions: TranslationReviseAgentOptions = {
      ...options,
      originSegments: rightSegments,
      draftSegments: rightDraftSegments,
      allowSegmentRetry: false,
      maxOutputTokens: context.maxOutputTokens,
    };

    const leftResult = await generateTranslationRevision(leftOptions);
    const rightResult = await generateTranslationRevision(rightOptions);

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

    const combinedRuns = [
      ...(leftResult.llm?.runs ?? []),
      ...(rightResult.llm?.runs ?? []),
    ];

    return {
      segments: mergedSegments,
      mergedText,
      usage: combinedUsage,
      meta: combinedMeta,
      model: leftResult.model,
      llm: combinedRuns.length ? { runs: combinedRuns } : undefined,
    } satisfies TranslationReviseAgentResult;
  };

  segmentRetrySegments = null;
  segmentRetryUsage = null;
  segmentRetryMeta = null;
  segmentRetryModel = null;
  segmentRetryRuns = null;
  const runResult = await runResponsesWithRetry<Response>({
    client: openai,
    initialMaxOutputTokens: baseMaxTokens,
    maxOutputTokensCap: REVISE_MAX_OUTPUT_TOKENS_CAP,
    maxAttempts: Math.max(attemptConfigs.length + 2, 3),
    minOutputTokens: 200,
    onAttempt: (context) => {
      if (!isTranslationDebugEnabled()) {
        return;
      }
      const attemptConfig = context.usingFallback && fallbackAttemptConfig
        ? fallbackAttemptConfig
        : pickPrimaryAttemptConfig(context.attemptIndex);
      console.debug("[TRANSLATION] revise run attempt", {
        ...describeAttempt(context, attemptConfig),
      });
    },
    buildRequest: async (context) =>
      executeRequest(context, pickPrimaryAttemptConfig(context.attemptIndex)),
    buildFallbackRequest: fallbackAttemptConfig
      ? async (context) => executeRequest(context, fallbackAttemptConfig)
      : undefined,
    retrySegmentFn: canSegmentRetry
      ? async (context) => {
          const aggregate = await reviseSegmentsWithSplit(
            options.originSegments,
            context,
          );
          if (!aggregate) {
            return null;
          }
          segmentRetrySegments = aggregate.segments;
          segmentRetryUsage = aggregate.usage;
          segmentRetryMeta = aggregate.meta;
          segmentRetryModel = aggregate.model;
          segmentRetryRuns = aggregate.llm?.runs ?? null;
          return buildSyntheticResponse(aggregate);
        }
      : undefined,
  });

  const {
    parsedJson,
    usage: responseUsage,
    repairApplied,
    requestId,
  } = safeExtractOpenAIResponse(runResult.response);

  if (!parsedJson || typeof parsedJson !== "object") {
    throw new Error("Revision response did not include any segments");
  }

  const payload = parsedJson as {
    segments?: Array<{ segmentId?: string; revision?: string }>;
  };

  if (!payload.segments) {
    throw new Error("Revision response did not include any segments");
  }

  const hasAll = payload.segments.every(
    (segment) =>
      typeof segment?.segmentId === "string" &&
      typeof segment?.revision === "string",
  );
  if (!hasAll) {
    throw new Error("Revision response returned invalid segment entries");
  }

  const providedIds = new Set(
    payload.segments.map((segment) => segment.segmentId as string),
  );
  const missing = expectedIds.filter((id) => !providedIds.has(id));
  if (missing.length) {
    throw new Error(
      `Revision response missing segments: ${missing.slice(0, 5).join(", ")}`,
    );
  }

  const parsedSegments = payload.segments.map((segment) => ({
    segmentId: segment.segmentId as string,
    revision: (segment.revision ?? "").toString(),
  }));

  const baseUsage = {
    inputTokens: responseUsage?.prompt_tokens ?? 0,
    outputTokens: responseUsage?.completion_tokens ?? 0,
  };

  const lastAttemptContext =
    runResult.attemptHistory[runResult.attemptHistory.length - 1] ?? null;
  const finalAttemptConfig = lastAttemptContext
    ? lastAttemptContext.usingFallback && fallbackAttemptConfig
      ? fallbackAttemptConfig
      : pickPrimaryAttemptConfig(lastAttemptContext.attemptIndex)
    : pickPrimaryAttemptConfig(runResult.attempts - 1);
  const firstAttemptConfig = pickPrimaryAttemptConfig(0);
  let fallbackModelUsed =
    Boolean(lastAttemptContext?.usingFallback) ||
    finalAttemptConfig.model !== firstAttemptConfig.model;

  const retrySegments = segmentRetrySegments as
    | TranslationReviseSegmentResult[]
    | null;
  const retryUsage = segmentRetryUsage as
    | { inputTokens: number; outputTokens: number }
    | null;
  const retryMeta = segmentRetryMeta as TranslationReviseAgentResultMeta | null;
  const retryModel = segmentRetryModel as string | null;
  const retryRuns = segmentRetryRuns as TranslationReviseLLMRunMeta[] | null;

  const segmentMeta = retryMeta;
  const segmentModel = retryModel;
  const segmentAttempts = segmentMeta?.attempts ?? 0;
  const totalAttempts = runResult.attempts + segmentAttempts;
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
  const usage = retryUsage ? { ...retryUsage } : baseUsage;

  if (isTranslationDebugEnabled()) {
    console.debug("[TRANSLATION] revise run success", {
      attempts: totalAttempts,
      truncated: truncatedFlag,
      model: segmentModel ?? runResult.response.model ?? finalAttemptConfig.model,
      maxOutputTokens: maxTokensUsed,
    });
  }

  const llmRun: TranslationReviseLLMRunMeta = {
    requestId: requestId ?? runResult.response.id ?? null,
    model: segmentModel ?? runResult.response.model ?? finalAttemptConfig.model,
    maxOutputTokens: maxTokensUsed,
    attempts: totalAttempts,
    truncated: truncatedFlag,
    verbosity: finalAttemptConfig.verbosity,
    reasoningEffort: finalAttemptConfig.effort,
    usage: {
      promptTokens: segmentModel
        ? usage.inputTokens
        : responseUsage?.prompt_tokens ?? null,
      completionTokens: segmentModel
        ? usage.outputTokens
        : responseUsage?.completion_tokens ?? null,
      totalTokens: segmentModel
        ? usage.inputTokens + usage.outputTokens
        : responseUsage?.total_tokens ?? null,
    },
  };

  const draftMap = new Map(
    options.draftSegments.map((segment) => [segment.segment_id, segment]),
  );

  const orderedSegments: TranslationReviseSegmentResult[] =
    options.originSegments.map((segment) => {
      const revisionEntry = parsedSegments.find(
        (entry) => entry.segmentId === segment.id,
      );
      const draft = draftMap.get(segment.id);
      const revision = (
        revisionEntry?.revision ??
        draft?.translation_segment ??
        segment.text
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
    });

  const finalSegments = retrySegments ?? orderedSegments;
  const mergedText = mergeSegmentsToText(options.originSegments, finalSegments);
  return {
    model: segmentModel ?? runResult.response.model ?? finalAttemptConfig.model,
    usage,
    segments: finalSegments,
    mergedText,
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
    },
    llm: { runs: retryRuns ? [...retryRuns, llmRun] : [llmRun] },
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

function buildRevisePrompt(notes: TranslationNotes | null): string {
  const guideline = [
    "Preserve meaning and narrative voice; only adjust style, rhythm, clarity.",
    "Do not introduce new information or summarize.",
    "Keep metaphor, cultural references, and character voice intact.",
    "Use natural prose suitable for publication.",
    "Maintain paragraph alignment with the source segments.",
  ];
  if (notes?.timePeriod) {
    guideline.push(
      `Honor the historical/cultural context of ${notes.timePeriod}.`,
    );
  }
  return [
    "You are the Revise agent polishing a draft translation.",
    "Given origin text + draft text for each segment, produce a refined version that preserves meaning but improves flow.",
    "Guidelines:",
    ...guideline.map((line) => `- ${line}`),
  ].join("\n");
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
    revisedSegments.map((entry) => [
      entry.segment_id,
      entry.revised_segment.trim(),
    ]),
  );
  return originSegments
    .map((origin, index) => {
      const revised = map.get(origin.id) ?? "";
      const previous = index > 0 ? originSegments[index - 1] : null;
      const needsBreak =
        previous && previous.paragraphIndex !== origin.paragraphIndex;
      const separator = index === 0 ? "" : needsBreak ? "\n\n" : "\n";
      return `${separator}${revised}`;
    })
    .join("")
    .trim();
}
