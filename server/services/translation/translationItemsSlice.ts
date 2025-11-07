import type { AgentItemsResponseV2 } from "../responsesSchemas";
import { query } from "../../db";
import type { OriginSegment } from "../../agents/translation";
import {
  buildTranslationPages,
  parseTranslationCursor,
  serializeTranslationCursor,
  type TranslationSegmentText,
} from "./translationPages";
import { loadCanonicalSegments } from "./segmentationEngine";
import { calculateTokenBudget } from "./tokenBudget";
import { getTranslationRunSummary } from "../translationSummary";
import type { TranslationRunSummaryResponse } from "../translationSummary";

const TRANSLATION_STAGE_ORDER: Array<"draft" | "revise"> = [
  "draft",
  "revise",
];

const deriveJobIdFromRunId = (runId: string): string => {
  if (runId.startsWith("translation:")) {
    return runId.slice("translation:".length);
  }
  return runId;
};

interface TranslationStagePageEntry {
  stage: "draft" | "revise";
  pageIndex: number;
  cursorHash: string | null;
  page: AgentItemsResponseV2;
}

const loadStageRows = async (params: {
  projectId: string;
  jobId: string;
  stage: "draft" | "revise";
}): Promise<
  Array<{
    segment_id: string | null;
    segment_index: number | null;
    text_source: string | null;
    text_target: string | null;
  }>
> => {
  const { rows } = await query(
    `SELECT segment_id, segment_index, text_source, text_target
       FROM translation_drafts
      WHERE project_id = $1
        AND job_id = $2
        AND stage = $3
      ORDER BY segment_index ASC`,
    [params.projectId, params.jobId, params.stage],
  );
  return rows as Array<{
    segment_id: string | null;
    segment_index: number | null;
    text_source: string | null;
    text_target: string | null;
  }>;
};

const toOriginSegments = (
  rows: Array<{
    segment_id: string | null;
    segment_index: number | null;
    text_source: string | null;
  }>,
): OriginSegment[] =>
  rows.map((row, index) => {
    const segmentId = row.segment_id && row.segment_id.trim().length
      ? row.segment_id.trim()
      : `segment-${index}`;
    const textSource = row.text_source ?? "";
    const idx = Number.isFinite(row.segment_index)
      ? Number(row.segment_index)
      : index;
    return {
      id: segmentId,
      index: idx,
      text: textSource,
      paragraphIndex: 0,
      sentenceIndex: null,
    } satisfies OriginSegment;
  });

const toSegmentTexts = (
  rows: Array<{
    segment_id: string | null;
    text_target: string | null;
    text_source: string | null;
  }>,
): TranslationSegmentText[] =>
  rows
    .map((row) => {
      const segmentId = row.segment_id && row.segment_id.trim().length
        ? row.segment_id.trim()
        : null;
      if (!segmentId) return null;
      const rawText = row.text_target ?? row.text_source ?? "";
      const text = typeof rawText === "string" ? rawText.trim() : "";
      if (!text.length) return null;
      return { segmentId, text } satisfies TranslationSegmentText;
    })
    .filter((entry): entry is TranslationSegmentText => entry !== null);

const buildMergedText = (segments: TranslationSegmentText[]): string =>
  segments.map((segment) => segment.text).join("\n\n");

const buildApproximateOriginText = (segments: OriginSegment[]): string => {
  let result = "";
  let previousParagraph: number | null = null;
  segments.forEach((segment) => {
    const text = segment.text?.trim();
    if (!text) {
      return;
    }
    const currentParagraph = Number.isFinite(segment.paragraphIndex)
      ? Number(segment.paragraphIndex)
      : null;
    const separator = result.length === 0
      ? ""
      : previousParagraph !== null && currentParagraph !== null
        ? currentParagraph !== previousParagraph
          ? "\n\n"
          : "\n"
        : "\n";
    result += `${separator}${text}`;
    previousParagraph = currentParagraph;
  });
  return result;
};

const collectStagePages = async (params: {
  projectId: string;
  runId: string;
  jobId: string;
  stage: "draft" | "revise";
  model: string;
}): Promise<TranslationStagePageEntry[]> => {
  const rows = await loadStageRows({
    projectId: params.projectId,
    jobId: params.jobId,
    stage: params.stage,
  });

  if (!rows.length) {
    return [];
  }

  const originSegments = toOriginSegments(rows);
  const segmentTexts = toSegmentTexts(rows);
  if (!segmentTexts.length) {
    return [];
  }

  const mergedText = buildMergedText(segmentTexts);

  const approximateOriginText = buildApproximateOriginText(originSegments);

  const canonicalResult = await loadCanonicalSegments({
    runId: params.runId,
    originText: approximateOriginText,
  });
  const canonicalSegments = canonicalResult?.segments?.length
    ? canonicalResult.segments
    : originSegments.map((segment, index) => {
        const text = segment.text ?? "";
        const budget = calculateTokenBudget({
          originSegments: [{ tokenEstimate: Math.ceil(text.length / 4), text }],
          mode: params.stage,
        });
        return {
          id: segment.id,
          hash: `legacy-${segment.id}`,
          segmentOrder: index,
          paragraphIndex: segment.paragraphIndex,
          sentenceIndex: segment.sentenceIndex,
          startOffset: 0,
          endOffset: 0,
          overlapPrev: false,
          overlapNext: false,
          overlapTokens: 0,
          tokenEstimate: Math.max(1, Math.ceil(text.length / 4)),
          tokenBudget: budget.tokensInCap,
          text,
        };
      });

  const { pages } = buildTranslationPages({
    runId: params.runId,
    stage: params.stage,
    jobId: params.jobId,
    model: params.model,
    mergedText,
    originSegments,
    canonicalSegments,
    segmentTexts,
    usage: { inputTokens: null, outputTokens: null },
    meta: {
      truncated: false,
      retryCount: 0,
      fallbackModelUsed: false,
      jsonRepairApplied: false,
    },
    latencyMs: 0,
  });

  return pages.map((page, index) => ({
    stage: params.stage,
    pageIndex: index,
    cursorHash: page.segment_hashes?.[0] ?? null,
    page,
  }));
};

const collectAllStagePages = async (params: {
  projectId: string;
  runId: string;
  jobId: string;
  model: string;
}): Promise<TranslationStagePageEntry[]> => {
  const entries: TranslationStagePageEntry[] = [];
  for (const stage of TRANSLATION_STAGE_ORDER) {
    const stageEntries = await collectStagePages({
      ...params,
      stage,
    });
    entries.push(...stageEntries);
  }
  return entries;
};

const resolveStartIndex = (
  entries: TranslationStagePageEntry[],
  cursor: string | null,
): number => {
  if (!cursor) return 0;
  const parsed = parseTranslationCursor(cursor);
  if (!parsed) {
    const numeric = Number(cursor);
    if (Number.isFinite(numeric) && numeric >= 0) {
      return Math.min(Math.floor(numeric), entries.length);
    }
    return 0;
  }
  if (parsed.hash) {
    const byHash = entries.findIndex(
      (entry) => entry.stage === parsed.stage && entry.cursorHash === parsed.hash,
    );
    if (byHash >= 0) {
      return byHash;
    }
  }

  if (parsed.pageIndex !== null) {
    const byIndex = entries.findIndex(
      (entry) =>
        entry.stage === parsed.stage && entry.pageIndex === parsed.pageIndex,
    );
    if (byIndex >= 0) {
      return byIndex;
    }
  }

  // If exact page not found, move to the first entry of the requested stage
  const stageIndex = entries.findIndex((entry) => entry.stage === parsed.stage);
  return stageIndex >= 0 ? stageIndex : 0;
};

export interface TranslationItemsSliceEvent {
  type: "items";
  data: AgentItemsResponseV2;
}

export interface TranslationItemsSlice {
  events: TranslationItemsSliceEvent[];
  nextCursor: string | null;
  hasMore: boolean;
  total: number;
}

export async function getTranslationItemsSlice(params: {
  projectId: string;
  runId: string;
  cursor?: string | null;
  limit?: number | null;
}): Promise<
  | {
      summary: TranslationRunSummaryResponse;
      slice: TranslationItemsSlice;
    }
  | null
> {
  const summary = await getTranslationRunSummary({
    projectId: params.projectId,
    runId: params.runId,
    jobId: null,
  });

  if (!summary) {
    return null;
  }

  const jobId = summary.jobId ?? deriveJobIdFromRunId(params.runId);
  if (!jobId) {
    return null;
  }

  const entries = await collectAllStagePages({
    projectId: params.projectId,
    runId: params.runId,
    jobId,
    model: summary.usage.primaryModel ?? "unknown",
  });

  if (!entries.length) {
    return {
      summary,
      slice: {
        events: [],
        nextCursor: null,
        hasMore: false,
        total: 0,
      },
    };
  }

  const limitRaw = params.limit ?? null;
  const limit = Math.min(Math.max(Number(limitRaw ?? 2) || 2, 1), 10);
  const startIndex = resolveStartIndex(entries, params.cursor ?? null);
  const sliceEntries = entries.slice(startIndex, startIndex + limit);
  const nextIndex = startIndex + sliceEntries.length;
  const hasMore = nextIndex < entries.length;
  const nextCursor = hasMore
    ? (() => {
        const nextEntry = entries[nextIndex];
        if (!nextEntry?.cursorHash) {
          return null;
        }
        const serialized = serializeTranslationCursor(
          nextEntry.stage,
          nextEntry.cursorHash,
        );
        return serialized || null;
      })()
    : null;

  return {
    summary,
    slice: {
      events: sliceEntries.map((entry) => ({
        type: "items" as const,
        data: entry.page,
      })),
      nextCursor,
      hasMore,
      total: entries.length,
    },
  };
}
