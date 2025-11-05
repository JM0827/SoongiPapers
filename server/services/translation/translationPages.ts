import { Buffer } from "node:buffer";

import type { AgentItemsResponseV2 } from "../responsesSchemas";
import type { OriginSegment } from "../../agents/translation";

export interface TranslationSegmentText {
  segmentId: string;
  text: string;
}

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), 200);
};

export const TRANSLATION_STREAM_PAGE_SIZE = parsePositiveInt(
  process.env.TRANSLATION_STREAM_PAGE_SIZE,
  40,
);

const chunkArray = <T>(items: T[], chunkSize: number): T[][] => {
  if (!Array.isArray(items) || items.length === 0) {
    return [[]];
  }
  const size = Math.max(1, chunkSize);
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks.length ? chunks : [[]];
};

const distributeTokens = (total: number, counts: number[]): number[] => {
  if (!Number.isFinite(total) || total <= 0) {
    return counts.map(() => 0);
  }
  const sum = counts.reduce((acc, count) => acc + count, 0);
  if (sum <= 0) {
    const fallback = Math.floor(total / Math.max(1, counts.length)) || 0;
    return counts.map(() => fallback);
  }
  let remaining = Math.floor(total);
  return counts.map((count, index) => {
    if (index === counts.length - 1) {
      return Math.max(0, remaining);
    }
    const portion = Math.max(0, Math.round((total * count) / sum));
    remaining -= portion;
    return portion;
  });
};

export const serializeTranslationCursor = (
  stage: string,
  pageIndex: number,
): string => `${stage}:${pageIndex}`;

export const parseTranslationCursor = (
  cursor: string | null | undefined,
): { stage: string; pageIndex: number } | null => {
  if (!cursor) return null;
  const parts = cursor.split(":");
  if (parts.length !== 2) return null;
  const [stage, indexRaw] = parts;
  if (!stage) return null;
  const pageIndex = Number(indexRaw);
  if (!Number.isFinite(pageIndex) || pageIndex < 0) {
    return null;
  }
  return { stage, pageIndex: Math.floor(pageIndex) };
};

export function buildTranslationPages(params: {
  runId: string;
  stage: string;
  jobId: string;
  model: string;
  mergedText: string;
  originSegments: OriginSegment[];
  segmentTexts: TranslationSegmentText[];
  usage: { inputTokens: number | null; outputTokens: number | null };
  meta: {
    truncated: boolean;
    retryCount: number;
    fallbackModelUsed: boolean;
    jsonRepairApplied: boolean;
    downshiftCount?: number;
    forcedPaginationCount?: number;
    cursorRetryCount?: number;
  };
  latencyMs: number;
}): { pages: AgentItemsResponseV2[]; itemCount: number } {
  const {
    runId,
    stage,
    jobId,
    model,
    mergedText,
    originSegments,
    segmentTexts,
    usage,
    meta,
    latencyMs,
  } = params;

  const textLength = mergedText.length;
  const map = new Map(segmentTexts.map((entry) => [entry.segmentId, entry.text]));
  const items: AgentItemsResponseV2["items"] = [];
  let searchCursor = 0;

  originSegments.forEach((origin, index) => {
    const translated = map.get(origin.id)?.trim();
    if (!translated) return;
    const bounded = translated.slice(0, textLength);
    let start = mergedText.indexOf(bounded, searchCursor);
    if (start === -1) {
      start = mergedText.indexOf(bounded);
    }
    if (start === -1) {
      return;
    }
    const end = start + bounded.length;
    searchCursor = end;

    const severity = stage === "draft" ? "suggestion" : "warning";
    const snippet =
      bounded.length > 160 ? `${bounded.slice(0, 157)}…` : bounded;

    items.push({
      uid: `${origin.id}:${stage}`,
      k: `${stage}_segment`,
      s: severity as AgentItemsResponseV2["items"][number]["s"],
      r: snippet,
      t: "replace",
      i: [origin.index ?? index, origin.index ?? index],
      o: [start, end],
      fix: { text: bounded },
      cid: origin.id,
      side: "tgt",
    });
  });

  const warningLabels = Array.from(
    new Set([
      ...(meta.fallbackModelUsed ? ["fallback_model_used"] : []),
      ...(meta.jsonRepairApplied ? ["json_repair_applied"] : []),
    ]),
  );

  const chunkSize = Math.max(1, TRANSLATION_STREAM_PAGE_SIZE);
  const chunks = chunkArray(items, chunkSize);
  const counts = chunks.map((chunk) => chunk.length);
  const promptDistribution = distributeTokens(usage.inputTokens ?? 0, counts);
  const completionDistribution = distributeTokens(
    usage.outputTokens ?? 0,
    counts,
  );

  const totalItems = items.length;
  const baseChunkId = `${stage}:${jobId}`;
  const pages: AgentItemsResponseV2[] = chunks.map((chunk, index) => {
    const chunkId = index === 0 ? baseChunkId : `${baseChunkId}:${index}`;
    const isLast = index === chunks.length - 1;
    const itemBytes = chunk.length
      ? Math.floor(
          chunk.reduce(
            (totalBytes, item) => totalBytes + Buffer.byteLength(item.r, "utf8"),
            0,
          ) / chunk.length,
        )
      : 0;

    return {
      version: "v2",
      run_id: runId,
      chunk_id: chunkId,
      tier: stage,
      model,
      latency_ms: index === 0 ? Math.max(0, latencyMs) : 0,
      prompt_tokens: promptDistribution[index] ?? 0,
      completion_tokens: completionDistribution[index] ?? 0,
      finish_reason: meta.truncated && isLast ? "length" : "stop",
      truncated: Boolean(meta.truncated && isLast),
      partial: meta.retryCount > 0 ? true : undefined,
      warnings: warningLabels,
      index_base: 0,
      offset_semantics: "[start,end)",
      stats: {
        item_count: chunk.length,
        avg_item_bytes: itemBytes,
      },
      metrics: {
        downshift_count: Math.max(0, meta.downshiftCount ?? 0),
        forced_pagination: Boolean(meta.forcedPaginationCount && meta.forcedPaginationCount > 0),
        cursor_retry_count: Math.max(0, meta.cursorRetryCount ?? 0),
      },
      items: chunk,
      has_more: !isLast,
      next_cursor: !isLast ? serializeTranslationCursor(stage, index + 1) : "",
      provider_response_id: null,
    } satisfies AgentItemsResponseV2;
  });

  if (!pages.length) {
    pages.push({
      version: "v2",
      run_id: runId,
      chunk_id: baseChunkId,
      tier: stage,
      model,
      latency_ms: Math.max(0, latencyMs),
      prompt_tokens: usage.inputTokens ?? 0,
      completion_tokens: usage.outputTokens ?? 0,
      finish_reason: meta.truncated ? "length" : "stop",
      truncated: Boolean(meta.truncated),
      partial: meta.retryCount > 0 ? true : undefined,
      warnings: warningLabels,
      index_base: 0,
      offset_semantics: "[start,end)",
      stats: {
        item_count: 0,
        avg_item_bytes: 0,
      },
      metrics: {
        downshift_count: Math.max(0, meta.downshiftCount ?? 0),
        forced_pagination: Boolean(meta.forcedPaginationCount && meta.forcedPaginationCount > 0),
        cursor_retry_count: Math.max(0, meta.cursorRetryCount ?? 0),
      },
      items: [],
      has_more: false,
      next_cursor: "",
      provider_response_id: null,
    });
  }

  return {
    pages,
    itemCount: totalItems,
  };
}
