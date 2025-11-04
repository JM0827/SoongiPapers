import { Buffer } from "node:buffer";
import { OpenAI } from "openai";
import type { Response } from "openai/resources/responses/responses";
import pLimit from "p-limit";
import type {
  GuardFindingDetail,
  ProjectMemory,
} from "@bookko/translation-types";

import { safeExtractOpenAIResponse, estimateTokens } from "../../services/llm";
import {
  runResponsesWithRetry,
  type ResponsesRetryAttemptContext,
  type ResponsesRetryStage,
} from "../../services/openaiResponses";
import { getProofreadModelSequence } from "../../config/modelDefaults";
import type { TranslationNotes } from "../../models/DocumentProfile";
import type { IssueItem, GuardFinding } from "./config";
import {
  PROOFREAD_RESPONSE_SCHEMA_NAME,
  PROOFREAD_RESPONSE_SCHEMA_V2_NAME,
  proofreadResponseJsonSchemaV1,
  proofreadResponseJsonSchemaV2,
  ProofreadItemsResponseSchemaV1,
  type ProofreadItemsResponseV1,
  ProofreadIssueItemV1,
  AgentItemsPayloadSchemaV2,
  AgentItemsPayloadLightSchemaV2,
  type AgentItemsPayloadV2Light,
  AgentItemsPayloadV2,
  AgentItemsResponseV2,
  AgentItemV2,
  type AgentResponseParseResult,
  parseAgentResponse,
} from "../../services/responsesSchemas";

export type ResponseVerbosity = "low" | "medium" | "high";
export type ResponseReasoningEffort = "minimal" | "low" | "medium" | "high";

type Tier = "quick" | "deep";

type LLMUsageSnapshot = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
};

const computeAverageItemBytes = (items: AgentItemV2[]): number => {
  if (!items.length) return 0;
  const totalBytes = items.reduce((acc, item) => {
    const message = typeof item.r === "string" ? item.r : "";
    const textBytes = Buffer.byteLength(message, "utf8");
    return acc + textBytes;
  }, 0);
  return Math.max(0, Math.floor(totalBytes / items.length));
};

const clampFixNote = (note: string | undefined): string | undefined => {
  if (typeof note !== "string") return undefined;
  return note.length > 120 ? note.slice(0, 120) : note;
};

const sanitizeAgentItemFix = (item: AgentItemV2): AgentItemV2 => {
  if (!item.fix) return item;
  const nextFix: { text?: string; note?: string } = {};
  if (typeof item.fix.text === "string") {
    nextFix.text = item.fix.text;
  }
  if (typeof item.fix.note === "string") {
    nextFix.note = clampFixNote(item.fix.note);
  }
  if (Object.keys(nextFix).length === 0) {
    const { fix: _omit, ...rest } = item;
    return rest;
  }
  return {
    ...item,
    fix: nextFix,
  };
};

const convertLightItemToAgentItem = (
  item: AgentItemsPayloadV2Light["items"][number],
): AgentItemV2 => {
  const start = Math.max(0, item.span.start);
  const end = Math.max(start, item.span.end);
  const fixText = item.fix?.text;
  const fixNote = clampFixNote(item.fix?.note);

  const agentItem: AgentItemV2 = {
    k: item.k,
    s: item.s,
    r: item.r,
    t: item.t,
    i: [start, start],
    o: [start, end],
    side: "tgt",
  };

  if (typeof fixText === "string" || typeof fixNote === "string") {
    const fixPayload: { text?: string; note?: string } = {};
    if (typeof fixText === "string") {
      fixPayload.text = fixText;
    }
    if (typeof fixNote === "string") {
      fixPayload.note = fixNote;
    }
    if (Object.keys(fixPayload).length) {
      agentItem.fix = fixPayload;
    }
  }

  return sanitizeAgentItemFix(agentItem);
};

const convertLightPayloadToRich = (
  payload: AgentItemsPayloadV2Light,
): AgentItemsPayloadV2 => {
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  const items = rawItems.map(convertLightItemToAgentItem);
  return {
    version: "v2",
    items,
    has_more: false,
    next_cursor: null,
    warnings: [],
    stats: {
      item_count: items.length,
      avg_item_bytes: computeAverageItemBytes(items),
    },
    index_base: 0,
    offset_semantics: "[start,end)",
  } satisfies AgentItemsPayloadV2;
};

export type BuildAgentItemsPageOptions = {
  runId: string;
  chunkId: string;
  tier: Tier;
  model: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  finishReason?: AgentItemsResponseV2["finish_reason"];
  truncated: boolean;
  partial?: boolean;
  warnings?: string[];
  indexBase?: 0 | 1;
  offsetSemantics?: "[start,end)";
  items: AgentItemV2[];
  hasMore: boolean;
  nextCursor?: string | null;
  providerResponseId?: string | null;
  downshiftCount?: number;
  forcedPagination?: boolean;
  cursorRetryCount?: number;
};

export const buildAgentItemsPage = (
  options: BuildAgentItemsPageOptions,
): AgentItemsResponseV2 => {
  const sanitizedItems = options.items.map((item) =>
    sanitizeAgentItemFix({ ...item }),
  );
  const warnings = Array.from(
    new Set(
      [
        ...(options.warnings ?? []),
        options.forcedPagination ? "forced_pagination" : undefined,
      ].filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.length > 0,
      ),
    ),
  );

  const stats = {
    item_count: sanitizedItems.length,
    avg_item_bytes: computeAverageItemBytes(sanitizedItems),
  } satisfies AgentItemsResponseV2["stats"];

  const metrics = {
    downshift_count: Math.max(0, options.downshiftCount ?? 0),
    forced_pagination: Boolean(options.forcedPagination),
    cursor_retry_count: Math.max(0, options.cursorRetryCount ?? 0),
  } satisfies AgentItemsResponseV2["metrics"];

  const nextCursor = options.hasMore
    ? options.nextCursor ?? ""
    : "";

  const page: AgentItemsResponseV2 = {
    version: "v2",
    run_id: options.runId,
    chunk_id: options.chunkId,
    tier: options.tier,
    model: options.model,
    latency_ms: Math.max(0, options.latencyMs),
    prompt_tokens: Math.max(0, options.promptTokens),
    completion_tokens: Math.max(0, options.completionTokens),
    truncated: options.truncated,
    warnings,
    index_base: options.indexBase ?? 0,
    offset_semantics: options.offsetSemantics ?? "[start,end)",
    stats,
    metrics,
    items: sanitizedItems,
    has_more: options.hasMore,
    next_cursor: nextCursor,
    provider_response_id: options.providerResponseId ?? null,
  };

  if (options.finishReason) {
    page.finish_reason = options.finishReason;
  }
  if (typeof options.partial === "boolean") {
    page.partial = options.partial;
  }

  return page;
};

export type ProofreadingMemoryContext = {
  version: number | null;
  styleProfile?: {
    register?: string | null;
    rhythm?: string | null;
    avgSentenceTokens?: number | null;
  };
  romanizationPolicy?: string | null;
  timePeriod?: string | null;
  characters?: Array<{
    name: string;
    targetName?: string | null;
    gender?: string | null;
    age?: string | null;
    traits?: string[];
  }>;
  namedEntities?: Array<{
    name: string;
    targetName?: string | null;
  }>;
  terminology?: Array<{
    source: string;
    target?: string | null;
  }>;
  measurementUnits?: Array<{
    source: string;
    target?: string | null;
  }>;
  linguisticFeatures?: Array<{
    source: string;
    target?: string | null;
  }>;
};

type GuardWorkerSegment = {
  segment_id: string;
  segment_index: number;
  needs_review: boolean;
  guard_findings?: GuardFindingDetail[];
  guards?: Record<string, unknown> | null;
  source_excerpt?: string;
  target_excerpt?: string;
};

type GenericWorkerParams = {
  model?: string | null;
  systemPrompt: string;
  subKey: string;
  tier: Tier;
  kr: string;
  en: string;
  kr_id: number | null;
  en_id: number | null;
  cursor?: string | null;
  guardContext?: { segments: GuardWorkerSegment[] };
  memoryContext?: ProofreadingMemoryContext | null;
  verbosity?: ResponseVerbosity;
  reasoningEffort?: ResponseReasoningEffort;
  maxOutputTokens?: number;
  retryLimit?: number;
  allowSegmentRetry?: boolean;
};

type ProofreadingEvidence = {
  reference: "source" | "target" | "memory" | "other";
  quote: string;
  note?: string;
};

type NormalizedLLMItem = IssueItem;

export type GenericWorkerMeta = {
  model: string;
  requestId: string | null;
  maxOutputTokens: number;
  attempts: number;
  truncated: boolean;
  verbosity: ResponseVerbosity;
  reasoningEffort: ResponseReasoningEffort;
  usage: LLMUsageSnapshot;
  guardSegments: number;
  memoryContextVersion: number | null;
  jsonRepairApplied: boolean;
  attemptHistory: ResponsesRetryAttemptContext[];
  schemaVersion: "v1" | "v2";
  runId: string | null;
  hasMore: boolean;
  nextCursor: string | null;
  latencyMs: number | null;
  pageCount: number;
};

export type GenericWorkerResult = {
  items: NormalizedLLMItem[];
  meta: GenericWorkerMeta;
  pages: AgentItemsResponseV2[];
};

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });
const limit = pLimit(Number(process.env.MAX_WORKERS || 4));

const toPositiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const MAX_OUTPUT_TOKENS_CAP = toPositiveInteger(
  process.env.PROOFREADING_MAX_OUTPUT_TOKENS_CAP,
  4200,
);
const GLOBAL_VERBOSITY =
  (process.env.PROOFREADING_VERBOSITY as ResponseVerbosity | undefined) ??
  "low";
const DEFAULT_VERBOSITY_QUICK =
  (process.env.PROOFREAD_QUICK_VERBOSITY as ResponseVerbosity | undefined) ??
  GLOBAL_VERBOSITY ??
  "low";
const DEFAULT_VERBOSITY_DEEP =
  (process.env.PROOFREAD_DEEP_VERBOSITY as ResponseVerbosity | undefined) ??
  GLOBAL_VERBOSITY ??
  "medium";
const GLOBAL_EFFORT =
  (process.env.PROOFREADING_REASONING_EFFORT as
    | ResponseReasoningEffort
    | undefined) ?? "minimal";
const DEFAULT_EFFORT_QUICK =
  (process.env.PROOFREAD_QUICK_EFFORT as ResponseReasoningEffort | undefined) ??
  GLOBAL_EFFORT ??
  "minimal";
const DEFAULT_EFFORT_DEEP =
  (process.env.PROOFREAD_DEEP_EFFORT as ResponseReasoningEffort | undefined) ??
  GLOBAL_EFFORT ??
  "medium";
const DEFAULT_RETRY_LIMIT = Number(
  process.env.PROOFREADING_RESPONSES_MAX_RETRIES ?? 3,
);

const QUICK_MAX_OUTPUT_TOKENS = toPositiveInteger(
  process.env.PROOFREADING_QUICK_MAX_OUTPUT_TOKENS,
  2400,
);

const DEEP_MAX_OUTPUT_TOKENS = toPositiveInteger(
  process.env.PROOFREADING_DEEP_MAX_OUTPUT_TOKENS,
  3600,
);

const QUICK_MAX_ITEMS = toPositiveInteger(
  process.env.PROOFREADING_QUICK_MAX_ITEMS,
  40,
);

const DEEP_MAX_ITEMS = toPositiveInteger(
  process.env.PROOFREADING_DEEP_MAX_ITEMS,
  60,
);

const MIN_TEXT_SPLIT_LENGTH = toPositiveInteger(
  process.env.PROOFREADING_MIN_TEXT_SPLIT_LENGTH,
  400,
);

export async function runGenericWorker(
  params: GenericWorkerParams,
): Promise<GenericWorkerResult> {
  return limit(() => callWithRetries(params));
}

function splitTextForRetry(text: string): [string, string] | null {
  const trimmed = text.trim();
  if (trimmed.length <= MIN_TEXT_SPLIT_LENGTH * 2) {
    return null;
  }

  const midpoint = Math.floor(trimmed.length / 2);
  const searchWindow = Math.floor(trimmed.length * 0.25);

  const probe = (start: number, direction: -1 | 1) => {
    const limit = direction === -1 ? 0 : trimmed.length;
    let index = start;
    while (direction === -1 ? index > limit : index < limit) {
      const char = trimmed[index];
      if (char === "\n") return index;
      if (
        (char === "." || char === "!" || char === "?" || char === "。") &&
        index + 1 < trimmed.length &&
        trimmed[index + 1] === " "
      ) {
        return index + 1;
      }
      if (Math.abs(index - start) > searchWindow) break;
      index += direction;
    }
    return -1;
  };

  let pivot = probe(midpoint, -1);
  if (pivot === -1) {
    pivot = probe(midpoint, 1);
  }
  if (pivot === -1) {
    pivot = midpoint;
  }

  if (pivot < MIN_TEXT_SPLIT_LENGTH || pivot > trimmed.length - MIN_TEXT_SPLIT_LENGTH) {
    return null;
  }

  const left = trimmed.slice(0, pivot).trim();
  const right = trimmed.slice(pivot).trim();
  if (!left.length || !right.length) {
    return null;
  }
  return [left, right];
}

async function callWithRetries(
  params: GenericWorkerParams,
): Promise<GenericWorkerResult> {
  const guardPayload = buildGuardPayload(params.guardContext);
  const memoryPayload = sanitizeMemoryContext(params.memoryContext ?? null);
  const guardSegmentsCount = params.guardContext?.segments?.length ?? 0;
  const memoryVersion = params.memoryContext?.version ?? null;

  const canSegmentRetry =
    (params.allowSegmentRetry ?? true) &&
    params.kr.trim().length > MIN_TEXT_SPLIT_LENGTH * 2 &&
    params.en.trim().length > MIN_TEXT_SPLIT_LENGTH * 2;

  const runSegmentRetry = async (
    context: ResponsesRetryAttemptContext,
  ): Promise<GenericWorkerResult | null> => {
    const krSplit = splitTextForRetry(params.kr);
    const enSplit = splitTextForRetry(params.en);
    if (!krSplit || !enSplit || krSplit.length !== enSplit.length) {
      return null;
    }

    const partialResults: GenericWorkerResult[] = [];
    for (let index = 0; index < krSplit.length; index += 1) {
      const subsetParams: GenericWorkerParams = {
        ...params,
        kr: krSplit[index],
        en: enSplit[index],
        allowSegmentRetry: false,
      };
      try {
        const subsetResult = await callWithRetries(subsetParams);
        partialResults.push(subsetResult);
      } catch {
        return null;
      }
    }

    const sumUsageField = (
      selector: (usage: LLMUsageSnapshot) => number | null,
    ) => {
      let sum = 0;
      let counted = false;
      for (const result of partialResults) {
        const value = selector(result.meta.usage);
        if (typeof value === "number" && Number.isFinite(value)) {
          sum += value;
          counted = true;
        } else {
          return null;
        }
      }
      return counted ? sum : null;
    };

    const combinedUsage: LLMUsageSnapshot = {
      promptTokens: sumUsageField((usage) => usage.promptTokens ?? null),
      completionTokens: sumUsageField((usage) => usage.completionTokens ?? null),
      totalTokens: sumUsageField((usage) => usage.totalTokens ?? null),
    };

    const combinedAttempts = partialResults.reduce(
      (acc, result) => acc + result.meta.attempts,
      0,
    );
    const combinedHistory = partialResults.flatMap(
      (result) => result.meta.attemptHistory ?? [],
    );

    const primaryMeta = partialResults[0]?.meta;
    if (!primaryMeta) return null;

    const schemaVersion = partialResults.every(
      (result) => result.meta.schemaVersion === "v2",
    )
      ? "v2"
      : "v1";
    const totalLatency = partialResults.reduce(
      (acc, result) => acc + (result.meta.latencyMs ?? 0),
      0,
    );
    const aggregatePages = partialResults.flatMap((result) => result.pages);

    const aggregateMeta: GenericWorkerMeta = {
      model: primaryMeta.model,
      requestId: primaryMeta.requestId,
      maxOutputTokens: partialResults.reduce(
        (acc, result) => Math.max(acc, result.meta.maxOutputTokens),
        primaryMeta.maxOutputTokens,
      ),
      attempts: combinedAttempts,
      truncated: false,
      verbosity: primaryMeta.verbosity,
      reasoningEffort: primaryMeta.reasoningEffort,
      usage: combinedUsage,
      guardSegments: guardSegmentsCount,
      memoryContextVersion: memoryVersion,
      jsonRepairApplied: partialResults.some(
        (result) => result.meta.jsonRepairApplied,
      ),
      attemptHistory: [...combinedHistory, context],
      schemaVersion,
      runId: primaryMeta.runId,
      hasMore: partialResults.some((result) => result.meta.hasMore),
      nextCursor:
        partialResults[partialResults.length - 1]?.meta.nextCursor ?? null,
      latencyMs: totalLatency,
      pageCount: aggregatePages.length,
    };

    return {
      items: partialResults.flatMap((result) => result.items),
      meta: aggregateMeta,
      pages: aggregatePages,
    } satisfies GenericWorkerResult;
  };

  let segmentRetryResult: GenericWorkerResult | null = null;

  const buildSegmentRetryResponse = (
    aggregate: GenericWorkerResult,
  ): Response => {
    const normalized = aggregate.items.map((item) => ({
      ...item,
    }));
    const payload = { version: "v1", items: normalized };
    const payloadText = JSON.stringify(payload);
    return {
      id: `proof-segment-retry-${Date.now().toString(16)}`,
      status: "completed",
      model: aggregate.meta.model,
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
        prompt_tokens: aggregate.meta.usage.promptTokens ?? undefined,
        completion_tokens: aggregate.meta.usage.completionTokens ?? undefined,
        total_tokens: aggregate.meta.usage.totalTokens ?? undefined,
      },
    } as unknown as Response;
  };

  const userPayload: Record<string, unknown> = {
    task: params.subKey,
    instruction:
      "Return a JSON object with shape {items:[{issue_ko,issue_en,recommendation_ko,recommendation_en,before,after,alternatives,rationale_ko,rationale_en,confidence,severity,tags,sourceExcerpt,translationExcerpt,evidence:[{reference,quote,note}],notes:{styleGuard,references,guardFindings}}]}",
    constraints: [
      "Preserve semantic content and voice.",
      "Minimize edits unless clearly better.",
      "If no issues, return items:[]",
    ],
    source_text: params.kr,
    target_text: params.en,
  };

  if (guardPayload) {
    userPayload.guard_context = guardPayload;
  }
  if (memoryPayload) {
    userPayload.memory_context = memoryPayload;
  }

  const pageLimit = params.tier === "deep" ? DEEP_MAX_ITEMS : QUICK_MAX_ITEMS;
  const initialCursor = params.cursor ?? null;

  const buildV2UserPayload = (cursor: string | null, limit: number) => {
    const payload: Record<string, unknown> = {
      task: params.subKey,
      schema_version: "v2",
      cursor,
      limit,
      index_base: 0,
      offset_semantics: "[start,end)",
      tier: params.tier,
      instructions: [
        `Return JSON matching schema '${PROOFREAD_RESPONSE_SCHEMA_V2_NAME}'.`,
        `Return at most ${pageLimit} items.`,
        "Never copy source_text or target_text into any field; use sentence indexes and character offsets instead.",
        "Populate 'i' with [start,end] sentence indices (0-based, inclusive).",
        "Populate 'o' with [start,end) character offsets measured on target_text (UTF-16 code units).",
        "If more issues remain, set has_more=true; otherwise false.",
        'When has_more=true, set next_cursor to "continue"; otherwise null.',
      ],
      source_text: params.kr,
      target_text: params.en,
    };
    if (guardPayload) {
      payload.guard_context = guardPayload;
    }
    if (memoryPayload) {
      payload.memory_context = memoryPayload;
    }
    return payload;
  };

  const buildV1UserPayload = () => {
    const payload: Record<string, unknown> = {
      task: params.subKey,
      instruction:
        "Return a JSON object with shape {items:[{issue_ko,issue_en,recommendation_ko,recommendation_en,before,after,alternatives,rationale_ko,rationale_en,confidence,severity,tags,sourceExcerpt,translationExcerpt,evidence:[{reference,quote,note}],notes:{styleGuard,references,guardFindings}}]}",
      constraints: [
        "Preserve semantic content and voice.",
        "Minimize edits unless clearly better.",
        "If no issues, return items:[]",
      ],
      source_text: params.kr,
      target_text: params.en,
    };
    if (guardPayload) {
      payload.guard_context = guardPayload;
    }
    if (memoryPayload) {
      payload.memory_context = memoryPayload;
    }
    return payload;
  };

  const buildMessagesV2 = (cursor: string | null, limit: number) => [
    {
      role: "system" as const,
      content: [
        {
          type: "input_text" as const,
          text: `${params.systemPrompt}\n\nAlways use the proofreading response schema v2. Do not quote source or target text in your output.`,
        },
      ],
    },
    {
      role: "user" as const,
      content: [
        {
          type: "input_text" as const,
          text: JSON.stringify(buildV2UserPayload(cursor, limit)),
        },
      ],
    },
  ];

  const buildMessagesV1 = () => [
    {
      role: "system" as const,
      content: [{ type: "input_text" as const, text: params.systemPrompt }],
    },
    {
      role: "user" as const,
      content: [
        {
          type: "input_text" as const,
          text: JSON.stringify(buildV1UserPayload()),
        },
      ],
    },
  ];

  const baseMaxTokens = computeDynamicMaxTokens(params, guardSegmentsCount);

  const verbosity =
    params.verbosity ??
    (params.tier === "deep" ? DEFAULT_VERBOSITY_DEEP : DEFAULT_VERBOSITY_QUICK);
  const reasoningEffort =
    params.reasoningEffort ??
    (params.tier === "deep" ? DEFAULT_EFFORT_DEEP : DEFAULT_EFFORT_QUICK);
  const retryLimit = Math.max(1, params.retryLimit ?? DEFAULT_RETRY_LIMIT);

  let modelSequence = getProofreadModelSequence(params.model);
  if (params.tier === "quick") {
    const withoutMini = modelSequence.filter((model) => model !== "gpt-5-mini");
    modelSequence = ["gpt-5-mini", ...withoutMini];
  }

  let aggregateAttempts = 0;
  let truncatedEncountered = false;
  let lastError: unknown = null;
  let currentLimit = pageLimit;

  const computeLimitForStage = (stage: ResponsesRetryStage): number => {
    const multiplier = stage === "downshift"
      ? 0.7
      : stage === "minimal"
        ? 0.5
        : 1;
    const nextLimit = Math.max(8, Math.floor(pageLimit * multiplier));
    return Math.min(pageLimit, Math.max(1, nextLimit));
  };

  for (const modelName of modelSequence) {
    try {
      segmentRetryResult = null;
      const requestStart = Date.now();
      const runResult = await runResponsesWithRetry<Response>({
        client,
        initialMaxOutputTokens: baseMaxTokens,
        maxOutputTokensCap: MAX_OUTPUT_TOKENS_CAP,
        maxAttempts: retryLimit,
        minOutputTokens: 200,
        onAttempt: (context) => {
          currentLimit = computeLimitForStage(context.stage);
        },
        buildRequest: ({ maxOutputTokens }) =>
          client.responses.create({
            model: modelName,
            max_output_tokens: maxOutputTokens,
            text: {
              format: {
                type: "json_schema",
                name: PROOFREAD_RESPONSE_SCHEMA_V2_NAME,
                schema: proofreadResponseJsonSchemaV2,
                strict: true,
              },
              verbosity,
            },
            reasoning: { effort: reasoningEffort },
            input: buildMessagesV2(initialCursor, currentLimit),
          }),
        buildFallbackRequest: ({ maxOutputTokens }) =>
          client.responses.create({
            model: modelName,
            max_output_tokens: maxOutputTokens,
            text: {
              format: {
                type: "json_schema",
                name: PROOFREAD_RESPONSE_SCHEMA_NAME,
                schema: proofreadResponseJsonSchemaV1,
                strict: true,
              },
              verbosity,
            },
            reasoning: { effort: reasoningEffort },
            input: buildMessagesV1(),
          }),
        retrySegmentFn: canSegmentRetry
          ? async (context) => {
              const aggregate = await runSegmentRetry(context);
              if (!aggregate) {
                return null;
              }
              segmentRetryResult = aggregate;
              return buildSegmentRetryResponse(aggregate);
            }
          : undefined,
      });
      const latencyMs = Date.now() - requestStart;

      aggregateAttempts += runResult.attempts;
      truncatedEncountered = truncatedEncountered || runResult.truncated;

      const {
        parsedJson,
        usage: responseUsage,
        requestId,
        repairApplied,
      } = safeExtractOpenAIResponse(runResult.response);

      let schemaVersion: "v1" | "v2" = "v2";
      let agentItems: AgentItemV2[] = [];
      let items: NormalizedLLMItem[] = [];
      let parseFailed = false;

      let payloadForParse: unknown = parsedJson ?? { version: "v2", items: [] };
      if (!payloadForParse || typeof payloadForParse !== "object") {
        payloadForParse = { version: "v2", items: [] };
      }

      let v2Candidate: AgentItemsPayloadV2 | null = null;
      if (payloadForParse && typeof payloadForParse === "object") {
        const versionTag = (payloadForParse as { version?: unknown }).version;
        if (versionTag === "v2") {
          try {
            v2Candidate = AgentItemsPayloadSchemaV2.parse(payloadForParse);
          } catch (error) {
            try {
              const light = AgentItemsPayloadLightSchemaV2.parse(payloadForParse);
              v2Candidate = convertLightPayloadToRich(light);
            } catch (lightError) {
              if (!runResult.truncated) {
                throw lightError;
              }
              parseFailed = true;
              v2Candidate = convertLightPayloadToRich({ version: "v2", items: [] });
            }
          }
        }
      }

      if (v2Candidate) {
        payloadForParse = v2Candidate;
      }

      let parsedPayload: AgentResponseParseResult<ProofreadItemsResponseV1>;
      try {
        parsedPayload = parseAgentResponse(
          payloadForParse,
          ProofreadItemsResponseSchemaV1,
        );
      } catch (error) {
        if (!runResult.truncated) {
          throw error;
        }
        parseFailed = true;
        const fallbackPayload = convertLightPayloadToRich({
          version: "v2",
          items: [],
        });
        payloadForParse = fallbackPayload;
        parsedPayload = {
          version: "v2",
          data: fallbackPayload,
        };
      }

      let agentPayload: AgentItemsPayloadV2;
      if (parsedPayload.version === "v2") {
        agentPayload = parsedPayload.data as AgentItemsPayloadV2;
        schemaVersion = "v2";
        agentItems = agentPayload.items;
        items = normalizeAgentItems(agentItems, params, {
          guardContext: params.guardContext,
        });
      } else {
        schemaVersion = "v1";
        const legacyItems = (parsedPayload.data as ProofreadItemsResponseV1).items as ProofreadIssueItemV1[];
        items = normalizeV1Items(legacyItems, params, {
          guardContext: params.guardContext,
        });
        agentItems = convertLegacyItemsToAgentItems(legacyItems, params);
        agentPayload = {
          version: "v2",
          items: agentItems,
          has_more: false,
          next_cursor: null,
          warnings: ["legacy-schema"],
          stats: {
            item_count: agentItems.length,
            avg_item_bytes: computeAverageItemBytes(agentItems),
          },
        } satisfies AgentItemsPayloadV2;
      }

      if (!agentPayload.warnings) {
        agentPayload = {
          ...agentPayload,
          warnings: [],
        } satisfies AgentItemsPayloadV2;
      }
      if (!agentPayload.stats) {
        agentPayload = {
          ...agentPayload,
          stats: {
            item_count: agentItems.length,
            avg_item_bytes: computeAverageItemBytes(agentItems),
          },
        } satisfies AgentItemsPayloadV2;
      }
      const usageSnapshot: LLMUsageSnapshot = {
        promptTokens: responseUsage?.prompt_tokens ?? null,
        completionTokens: responseUsage?.completion_tokens ?? null,
        totalTokens: responseUsage?.total_tokens ?? null,
      };

      const resolvedModel = runResult.response.model ?? modelName;
      const responseId = runResult.response.id ?? null;
      const runId =
        responseId ??
        `proof-${params.subKey}-${params.en_id ?? "chunk"}-${Date.now().toString(16)}`;
      const chunkId = `${params.subKey}:${params.en_id ?? "chunk"}`;
      let hasMore = Boolean(agentPayload.has_more);
      let serverNextCursor =
        typeof agentPayload.next_cursor === "string"
          ? agentPayload.next_cursor
          : null;
      const downshiftAttempts = runResult.attemptHistory.filter(
        (attempt) =>
          attempt.stage === "downshift" || attempt.stage === "minimal",
      ).length;
      const truncatedOrPartial = runResult.truncated || Boolean(agentPayload.partial);
      let forcedPagination = truncatedOrPartial || parseFailed;
      if (forcedPagination) {
        hasMore = true;
      }
      if (
        hasMore &&
        (typeof serverNextCursor !== "string" || !serverNextCursor.trim())
      ) {
        serverNextCursor = `continue:${chunkId}:${aggregateAttempts}`;
      }
      if (!hasMore) {
        serverNextCursor = "";
      }

      const pageEnvelope = buildAgentItemsPage({
        runId,
        chunkId,
        tier: params.tier,
        model: resolvedModel,
        latencyMs,
        promptTokens: usageSnapshot.promptTokens ?? 0,
        completionTokens: usageSnapshot.completionTokens ?? 0,
        finishReason: extractFinishReason(runResult.response),
        truncated: runResult.truncated,
        partial: agentPayload.partial ?? undefined,
        warnings: agentPayload.warnings ?? [],
        indexBase: agentPayload.index_base ?? 0,
        offsetSemantics: agentPayload.offset_semantics ?? "[start,end)",
        items: agentItems,
        hasMore,
        nextCursor: hasMore ? serverNextCursor : "",
        providerResponseId: responseId,
        downshiftCount: downshiftAttempts,
        forcedPagination,
        cursorRetryCount: 0,
      });

      if (segmentRetryResult !== null) {
        const retryResult: GenericWorkerResult = segmentRetryResult;
        aggregateAttempts += retryResult.meta.attempts;
        truncatedEncountered = false;
        const combinedHistory = [
          ...runResult.attemptHistory,
          ...(retryResult.meta.attemptHistory ?? []),
        ];
        return {
          items: retryResult.items,
          meta: {
            model: retryResult.meta.model ?? resolvedModel,
            requestId:
              retryResult.meta.requestId ??
              requestId ??
              runResult.response.id ??
              null,
            maxOutputTokens: Math.max(
              runResult.maxOutputTokens,
              retryResult.meta.maxOutputTokens,
            ),
            attempts: aggregateAttempts,
            truncated: false,
            verbosity,
            reasoningEffort,
            usage: retryResult.meta.usage ?? usageSnapshot,
            guardSegments: guardSegmentsCount,
            memoryContextVersion: memoryVersion,
            jsonRepairApplied: retryResult.meta.jsonRepairApplied,
            attemptHistory: combinedHistory,
            schemaVersion: retryResult.meta.schemaVersion,
          runId: retryResult.meta.runId ?? runId,
          hasMore: retryResult.meta.hasMore,
          nextCursor: retryResult.meta.nextCursor,
            latencyMs: retryResult.meta.latencyMs,
            pageCount: retryResult.meta.pageCount,
          },
          pages:
            retryResult.pages.length > 0
              ? retryResult.pages
              : [pageEnvelope],
        } satisfies GenericWorkerResult;
      }

      return {
        items,
        meta: {
          model: resolvedModel,
          requestId: requestId ?? runResult.response.id ?? null,
          maxOutputTokens: runResult.maxOutputTokens,
          attempts: aggregateAttempts,
          truncated: truncatedEncountered || forcedPagination,
          verbosity,
          reasoningEffort,
          usage: usageSnapshot,
          guardSegments: guardSegmentsCount,
          memoryContextVersion: memoryVersion,
          jsonRepairApplied: Boolean(repairApplied),
          attemptHistory: runResult.attemptHistory,
          schemaVersion,
          runId,
          hasMore,
          nextCursor:
            hasMore && typeof serverNextCursor === "string" && serverNextCursor
              ? serverNextCursor
              : null,
          latencyMs,
          pageCount: 1,
        },
        pages: [pageEnvelope],
      } satisfies GenericWorkerResult;
    } catch (error) {
      lastError = error;
      continue;
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error("Proofreading run failed after trying all configured models");
}

function normalizeV1Items(
  rawItems: ProofreadIssueItemV1[],
  params: GenericWorkerParams,
  context: { guardContext?: { segments: GuardWorkerSegment[] } },
): IssueItem[] {
  const guardNotes = buildGuardNotes(context.guardContext);
  const guardSegments = Array.isArray(context.guardContext?.segments)
    ? context.guardContext!.segments
    : [];
  const guardSource =
    guardSegments.find((segment) => segment.source_excerpt)?.source_excerpt ??
    null;
  const guardTarget =
    guardSegments.find((segment) => segment.target_excerpt)?.target_excerpt ??
    null;

  const sourceSentences = splitChunkSentences(params.kr);
  const targetSentences = splitChunkSentences(params.en);

  return rawItems
    .map((item, index) =>
      normalizeSingleV1Item(
        item,
        params,
        index,
        sourceSentences,
        targetSentences,
        guardSource,
        guardTarget,
        guardNotes,
      ),
    )
    .filter((value): value is NormalizedLLMItem => Boolean(value));
}

function normalizeAgentItems(
  agentItems: AgentItemV2[],
  params: GenericWorkerParams,
  context: { guardContext?: { segments: GuardWorkerSegment[] } },
): IssueItem[] {
  const guardNotes = buildGuardNotes(context.guardContext);
  const guardSegments = Array.isArray(context.guardContext?.segments)
    ? context.guardContext!.segments
    : [];
  const guardSource =
    guardSegments.find((segment) => segment.source_excerpt)?.source_excerpt ??
    null;
  const guardTarget =
    guardSegments.find((segment) => segment.target_excerpt)?.target_excerpt ??
    null;

  const sourceSentences = splitChunkSentences(params.kr);
  const targetSentences = splitChunkSentences(params.en);

  return agentItems
    .map((item, index) =>
      normalizeSingleAgentItem(
        item,
        params,
        index,
        sourceSentences,
        targetSentences,
        guardSource,
        guardTarget,
        guardNotes,
      ),
    )
    .filter((value): value is NormalizedLLMItem => Boolean(value));
}

function normalizeSingleV1Item(
  raw: ProofreadIssueItemV1,
  params: GenericWorkerParams,
  index: number,
  sourceSentences: string[],
  targetSentences: string[],
  guardSource: string | null,
  guardTarget: string | null,
  guardNotes: ReturnType<typeof buildGuardNotes>,
): IssueItem | null {
  if (!raw || typeof raw !== "object") return null;

  const issueKo = toTrimmedString(raw.issue_ko);
  const issueEn = toTrimmedString(raw.issue_en);
  const recKo = toTrimmedString(raw.recommendation_ko);
  const recEn = toTrimmedString(raw.recommendation_en);
  const rationaleKo = toTrimmedString(raw.rationale_ko);
  const rationaleEn = toTrimmedString(raw.rationale_en);

  if (
    !issueKo ||
    !issueEn ||
    !recKo ||
    !recEn ||
    !rationaleKo ||
    !rationaleEn
  ) {
    return null;
  }

  const translationFragment =
    toTrimmedString(raw.translationExcerpt) ??
    toTrimmedString(raw.after) ??
    guardTarget ??
    null;

  const targetSelection = selectSentence(targetSentences, translationFragment);
  const sourceSelection = selectSentence(
    sourceSentences,
    toTrimmedString(raw.sourceExcerpt) ?? guardSource,
  );

  const fallbackSource =
    sourceSelection.text ??
    (targetSelection.index >= 0
      ? sourceSentences[targetSelection.index]
      : (guardSource ?? sourceSentences[0] ?? params.kr));
  const fallbackTarget =
    targetSelection.text ??
    (sourceSelection.index >= 0
      ? targetSentences[sourceSelection.index]
      : (guardTarget ??
        translationFragment ??
        targetSentences[0] ??
        params.en));

  const guardStatus = guardNotes.length ? "qa_also" : "llm_only";
  const guardStatusLabel =
    guardStatus === "qa_also" ? "번역 QA에서도 확인" : "교정 AI만 발견";

  const spans = normalizeSpan(raw.spans);
  const evidence = normalizeEvidence(
    raw.evidence,
    fallbackSource,
    fallbackTarget,
  );
  const notes = normalizeNotes(raw.notes, guardNotes);

  return {
    id: `${params.subKey}-${params.en_id}-${index}`,
    kr_sentence_id: params.kr_id,
    en_sentence_id: params.en_id,
    issue_ko: issueKo,
    issue_en: issueEn,
    recommendation_ko: recKo,
    recommendation_en: recEn,
    before: toTrimmedString(raw.before) ?? fallbackSource ?? "",
    after: toTrimmedString(raw.after) ?? fallbackTarget ?? "",
    alternatives: Array.isArray(raw.alternatives)
      ? raw.alternatives.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [],
    rationale_ko: rationaleKo,
    rationale_en: rationaleEn,
    spans,
    confidence: clampConfidence(raw.confidence),
    severity: normalizeSeverityValue(raw.severity),
    tags: Array.isArray(raw.tags)
      ? raw.tags.filter((entry): entry is string => typeof entry === "string")
      : [],
    source: toTrimmedString(raw.source) ?? fallbackSource ?? "",
    sourceExcerpt: toTrimmedString(raw.sourceExcerpt) ?? fallbackSource ?? "",
    translationExcerpt: translationFragment ?? fallbackTarget ?? "",
    evidence,
    notes,
    guardStatus,
    guardStatusLabel,
  };
}

function normalizeSpan(value: unknown): { start: number; end: number } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const start = typeof record.start === "number" ? record.start : null;
  const end = typeof record.end === "number" ? record.end : null;
  if (start === null || end === null) return null;
  return { start, end };
}

function normalizeEvidence(
  value: unknown,
  fallbackSource: string | null,
  fallbackTarget: string | null,
): ProofreadingEvidence[] {
  if (!Array.isArray(value)) {
    return [buildDefaultEvidence(fallbackSource, fallbackTarget)];
  }
  const entries = value
    .map((entry) => normalizeSingleEvidence(entry))
    .filter((entry): entry is ProofreadingEvidence => Boolean(entry));

  if (entries.length === 0) {
    entries.push(buildDefaultEvidence(fallbackSource, fallbackTarget));
  }
  return entries;
}

function normalizeSingleAgentItem(
  item: AgentItemV2,
  params: GenericWorkerParams,
  index: number,
  sourceSentences: string[],
  targetSentences: string[],
  guardSource: string | null,
  guardTarget: string | null,
  guardNotes: ReturnType<typeof buildGuardNotes>,
): IssueItem | null {
  const recommendation = toTrimmedString(item.r);
  if (!recommendation) return null;

  const sentenceRange = normalizeSentenceRange(item.i, sourceSentences.length);
  const targetRange = normalizeOffsetRange(item.o, params.en);

  const sourceFragment =
    sentenceRange && sentenceRange.start <= sentenceRange.end
      ? sliceSentences(sourceSentences, sentenceRange)
      : guardSource ?? sourceSentences[0] ?? params.kr;

  const targetFragment =
    targetRange !== null
      ? sliceByOffsets(params.en, targetRange)
      : sentenceRange
        ? sliceSentences(targetSentences, sentenceRange)
        : guardTarget ?? targetSentences[0] ?? params.en;

  const guardStatus = guardNotes.length ? "qa_also" : "llm_only";
  const guardStatusLabel =
    guardStatus === "qa_also" ? "번역 QA에서도 확인" : "교정 AI만 발견";

  const evidenceQuote = targetFragment ?? sourceFragment ?? "";
  const evidenceReference = targetFragment ? "target" : "source";

  const severity = mapAgentSeverity(item.s);
  const confidence = clampConfidence(item.conf);

  const notes = normalizeNotes(undefined, guardNotes);

  const fallbackSource = sourceFragment ?? guardSource ?? params.kr;
  const fallbackTarget = targetFragment ?? guardTarget ?? params.en;

  return {
    id: `${params.subKey}-${params.en_id}-${index}`,
    kr_sentence_id: sentenceRange?.start ?? null,
    en_sentence_id: sentenceRange?.start ?? null,
    issue_ko: recommendation,
    issue_en: recommendation,
    recommendation_ko: item.fix?.text ?? recommendation,
    recommendation_en: item.fix?.text ?? recommendation,
    before: fallbackTarget,
    after: item.fix?.text ?? fallbackTarget,
    alternatives: [],
    rationale_ko: item.fix?.note ?? recommendation,
    rationale_en: item.fix?.note ?? recommendation,
    spans:
      targetRange !== null
        ? { start: targetRange[0], end: targetRange[1] }
        : null,
    confidence,
    severity,
    tags: item.k ? [item.k] : [],
    source: params.subKey,
    sourceExcerpt: fallbackSource,
    translationExcerpt: fallbackTarget,
    evidence: [
      {
        reference: evidenceReference,
        quote: evidenceQuote,
        note: item.fix?.note ?? "",
      },
    ],
    notes,
    guardStatus,
    guardStatusLabel,
  };
}

function normalizeSentenceRange(
  range: AgentItemV2["i"],
  sentenceCount: number,
): { start: number; end: number } | null {
  if (!Array.isArray(range) || range.length < 2) return null;
  const start = Number.isFinite(range[0]) ? Math.max(0, range[0]) : 0;
  const end = Number.isFinite(range[1]) ? range[1] : start;
  const clampedStart = Math.min(Math.max(start, 0), Math.max(sentenceCount - 1, 0));
  const clampedEnd = Math.min(Math.max(end, clampedStart), Math.max(sentenceCount - 1, clampedStart));
  return { start: clampedStart, end: clampedEnd };
}

function normalizeOffsetRange(
  offsets: AgentItemV2["o"],
  text: string,
): [number, number] | null {
  if (!Array.isArray(offsets) || offsets.length < 2) return null;
  const start = Math.max(0, Math.min(offsets[0], text.length));
  const end = Math.max(start, Math.min(offsets[1], text.length));
  if (start === end) {
    return null;
  }
  return [start, end];
}

function sliceByOffsets(text: string, range: [number, number]): string {
  return text.slice(range[0], range[1]).trim();
}

function sliceSentences(
  sentences: string[],
  range: { start: number; end: number },
): string {
  return sentences.slice(range.start, range.end + 1).join(" \n").trim();
}

function mapAgentSeverity(value: AgentItemV2["s"]): "low" | "medium" | "high" {
  switch (value) {
    case "error":
      return "high";
    case "warning":
      return "medium";
    default:
      return "low";
  }
}

function convertLegacyItemsToAgentItems(
  items: ProofreadIssueItemV1[],
  params: GenericWorkerParams,
): AgentItemV2[] {
  return items.map((legacy, index) => {
    const baseIndex =
      typeof legacy.en_sentence_id === "number"
        ? legacy.en_sentence_id
        : typeof legacy.kr_sentence_id === "number"
          ? legacy.kr_sentence_id
          : index;
    const sentenceRange: [number, number] = [
      Math.max(0, baseIndex),
      Math.max(0, baseIndex),
    ];
    const offsets =
      normalizeLegacyOffsets(legacy, params.en) ?? [0, Math.min(params.en.length, 1)];
    const rationale =
      toTrimmedString(legacy.rationale_en) ??
      toTrimmedString(legacy.issue_en) ??
      "Review required";
    const fixText = toTrimmedString(legacy.after ?? legacy.translationExcerpt ?? null);
    const agentItem: AgentItemV2 = {
      uid: legacy.id ?? undefined,
      k: legacy.tags?.[0] ?? params.subKey ?? "proofread",
      s: mapLegacySeverityToAgent(legacy.severity),
      r: toTrimmedString(legacy.issue_en) ?? rationale,
      t: fixText ? "replace" : "note",
      i: sentenceRange,
      o: offsets,
    };
    if (typeof legacy.confidence === "number") {
      agentItem.conf = clampConfidence(legacy.confidence);
    }
    const fixNote = toTrimmedString(legacy.rationale_en);
    if (fixText || fixNote) {
      agentItem.fix = {};
      if (fixText) agentItem.fix.text = fixText;
      if (fixNote) agentItem.fix.note = fixNote;
    }
    return agentItem;
  });
}

function mapLegacySeverityToAgent(value: string | undefined): AgentItemV2["s"] {
  const normalized = (value ?? "").toLowerCase();
  if (normalized === "high") return "error";
  if (normalized === "medium") return "warning";
  return "suggestion";
}

function normalizeLegacyOffsets(
  item: ProofreadIssueItemV1,
  targetText: string,
): [number, number] | null {
  const spanStart = item.spans?.start;
  const spanEnd = item.spans?.end;
  if (
    typeof spanStart === "number" &&
    typeof spanEnd === "number" &&
    spanEnd > spanStart
  ) {
    const start = Math.max(0, Math.min(spanStart, targetText.length));
    const end = Math.max(start + 1, Math.min(spanEnd, targetText.length));
    return [start, end];
  }
  const excerpt =
    toTrimmedString(item.translationExcerpt) ??
    toTrimmedString(item.after) ??
    toTrimmedString(item.issue_en);
  if (excerpt) {
    const idx = targetText.indexOf(excerpt);
    if (idx !== -1) {
      return [idx, Math.min(targetText.length, idx + excerpt.length)];
    }
  }
  return null;
}

function extractFinishReason(
  response: Response | null | undefined,
): AgentItemsResponseV2["finish_reason"] | undefined {
  if (!response) return undefined;
  const outputItems = Array.isArray(response.output) ? response.output : [];
  for (const entry of outputItems) {
    const finish = (entry as { finish_reason?: string }).finish_reason;
    if (
      finish === "stop" ||
      finish === "length" ||
      finish === "content_filter" ||
      finish === "error"
    ) {
      return finish;
    }
  }
  if ((response as { status?: string }).status === "incomplete") {
    return "length";
  }
  const incompleteReason = (response as {
    incomplete_details?: { reason?: string };
  })?.incomplete_details?.reason;
  if (incompleteReason === "max_output_tokens") {
    return "length";
  }
  return undefined;
}

function normalizeSingleEvidence(value: unknown): ProofreadingEvidence | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const quote = toTrimmedString(record.quote);
  if (!quote) return null;
  const referenceRaw = toTrimmedString(record.reference);
  const reference: ProofreadingEvidence["reference"] =
    referenceRaw &&
    ["source", "target", "memory", "other"].includes(referenceRaw)
      ? (referenceRaw as ProofreadingEvidence["reference"])
      : "source";
  const noteValue = toTrimmedString(record.note) ?? "";
  return { reference, quote, note: noteValue };
}

function buildDefaultEvidence(
  fallbackSource: string | null,
  fallbackTarget: string | null,
): ProofreadingEvidence {
  const quote = fallbackTarget || fallbackSource || "[context unavailable]";
  return { reference: fallbackTarget ? "target" : "source", quote, note: "" };
}

function normalizeNotes(
  value: unknown,
  guardNotes: ReturnType<typeof buildGuardNotes>,
): IssueItem["notes"] {
  const styleGuard =
    value &&
    typeof value === "object" &&
    Array.isArray((value as Record<string, unknown>).styleGuard)
      ? ((value as Record<string, unknown>).styleGuard as unknown[]).filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
  const references =
    value &&
    typeof value === "object" &&
    Array.isArray((value as Record<string, unknown>).references)
      ? ((value as Record<string, unknown>).references as unknown[]).filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
  const guardFindings: GuardFinding[] = guardNotes.map((note) => ({
    type: note.type,
    summary: note.summary,
    severity: note.severity,
    segmentId: note.segmentId,
    needsReview: note.needsReview,
  }));

  return {
    styleGuard,
    references,
    guardFindings,
  };
}

function clampConfidence(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0.7;
  }
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeSeverityValue(value: unknown): "low" | "medium" | "high" {
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (lowered === "low" || lowered === "medium" || lowered === "high") {
      return lowered;
    }
  }
  return "low";
}

function computeDynamicMaxTokens(
  params: GenericWorkerParams,
  guardSegmentsCount: number,
): number {
  const sourceTokens = estimateTokens(params.kr);
  const targetTokens = estimateTokens(params.en);
  const guardPadding = guardSegmentsCount > 0 ? 150 : 0;
  const baseEstimate =
    targetTokens + Math.ceil(sourceTokens * 0.35) + guardPadding;
  const multiplier = params.tier === "deep" ? 1.75 : 1.45;
  const padding = params.tier === "deep" ? 260 : 160;
  const lowerBound = params.tier === "deep" ? 1800 : 1200;

  const requestedCapRaw = params.maxOutputTokens
    ? Number(params.maxOutputTokens)
    : params.tier === "deep"
      ? DEEP_MAX_OUTPUT_TOKENS
      : QUICK_MAX_OUTPUT_TOKENS;
  const requestedCap = Number.isFinite(requestedCapRaw) && requestedCapRaw > 0
    ? requestedCapRaw
    : lowerBound;

  const estimated = Math.max(
    lowerBound,
    Math.round((baseEstimate + padding) * multiplier),
  );

  const baseline = Math.max(estimated, requestedCap, lowerBound);
  return Math.min(baseline, MAX_OUTPUT_TOKENS_CAP);
}

function buildGuardPayload(context?: GenericWorkerParams["guardContext"]) {
  if (!context?.segments?.length) return undefined;
  return {
    flagged_segments: context.segments.map((segment) => ({
      segment_id: segment.segment_id,
      segment_index: segment.segment_index,
      needs_review: segment.needs_review,
      guard_checks: segment.guards ?? null,
      guard_findings: Array.isArray(segment.guard_findings)
        ? segment.guard_findings.map((finding) => ({
            type: finding.type,
            summary: finding.summary,
            severity: finding.severity ?? null,
          }))
        : [],
      source_excerpt: segment.source_excerpt ?? null,
      target_excerpt: segment.target_excerpt ?? null,
    })),
  };
}

function buildGuardNotes(context?: GenericWorkerParams["guardContext"]) {
  if (!context?.segments?.length) return [];
  const notes: Array<{
    type: string;
    summary: string;
    segmentId: string;
    severity?: string;
    needsReview?: boolean;
  }> = [];

  for (const segment of context.segments) {
    const findings = Array.isArray(segment.guard_findings)
      ? segment.guard_findings
      : [];
    for (const finding of findings) {
      notes.push({
        type: finding.type,
        summary: finding.summary,
        segmentId: segment.segment_id,
        severity: finding.severity ?? undefined,
        needsReview: segment.needs_review,
      });
    }
  }

  return notes;
}

function sanitizeMemoryContext(
  context: ProofreadingMemoryContext | null,
): ProofreadingMemoryContext | null {
  if (!context) return null;
  return {
    version: context.version ?? null,
    styleProfile: context.styleProfile ?? undefined,
    romanizationPolicy: context.romanizationPolicy ?? undefined,
    timePeriod: context.timePeriod ?? undefined,
    characters: context.characters ?? undefined,
    namedEntities: context.namedEntities ?? undefined,
    terminology: context.terminology ?? undefined,
    measurementUnits: context.measurementUnits ?? undefined,
    linguisticFeatures: context.linguisticFeatures ?? undefined,
  };
}

function toTrimmedString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }
  return null;
}

function splitChunkSentences(value?: string | null): string[] {
  if (!value) return [];
  return value
    .split(/\r?\n\r?\n+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function selectSentence(
  sentences: string[],
  fragment?: string | null,
): { text: string | null; index: number } {
  if (fragment) {
    const index = sentences.findIndex((sentence) =>
      sentence.includes(fragment),
    );
    if (index >= 0) {
      return { text: sentences[index], index };
    }
  }
  return { text: null, index: -1 };
}

export function buildProofreadingMemoryContext(params: {
  memory: ProjectMemory | null;
  translationNotes: TranslationNotes | null;
  version: number | null;
}): ProofreadingMemoryContext | null {
  const { memory: _memory, translationNotes, version } = params;
  void _memory;
  if (!translationNotes && version === null) return null;

  const context: ProofreadingMemoryContext = {
    version,
  };

  if (translationNotes?.timePeriod) {
    context.timePeriod = translationNotes.timePeriod;
  }
  if (Array.isArray(translationNotes?.characters)) {
    context.characters = translationNotes.characters.map((character) => ({
      name: character.name,
      targetName: character.targetName ?? null,
      gender: character.gender ?? null,
      age: character.age ?? null,
      traits: Array.isArray(character.traits)
        ? character.traits.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [],
    }));
  }
  if (Array.isArray(translationNotes?.namedEntities)) {
    context.namedEntities = translationNotes.namedEntities.map((entity) => ({
      name: entity.name,
      targetName: entity.targetName ?? null,
    }));
  }
  if (Array.isArray(translationNotes?.measurementUnits)) {
    context.measurementUnits = translationNotes.measurementUnits.map(
      (entry) => ({
        source: entry.source,
        target: entry.target ?? null,
      }),
    );
  }
  if (Array.isArray(translationNotes?.linguisticFeatures)) {
    context.linguisticFeatures = translationNotes.linguisticFeatures.map(
      (entry) => ({
        source: entry.source,
        target: entry.target ?? null,
      }),
    );
  }

  return context;
}
