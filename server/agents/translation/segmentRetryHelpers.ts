import type { OriginSegment } from "./segmentationAgent";
import type { TranslationDraftAgentSegmentResult } from "./translationDraftAgent";

export const MIN_SEGMENT_SPLIT_LENGTH = 120;

export function splitOriginSegmentForRetry(
  segment: OriginSegment,
): OriginSegment[] {
  const text = segment.text ?? "";
  const trimmed = text.trim();
  if (trimmed.length <= MIN_SEGMENT_SPLIT_LENGTH) {
    return [segment];
  }

  const pieces: OriginSegment[] = [];
  let remaining = trimmed;
  let counter = 0;

  while (remaining.length > MIN_SEGMENT_SPLIT_LENGTH * 1.5) {
    const midpoint = Math.floor(remaining.length / 2);
    const newlineBreak = remaining.lastIndexOf("\n", midpoint);
    const punctuationBreak = Math.max(
      remaining.lastIndexOf(". ", midpoint),
      remaining.lastIndexOf("。", midpoint),
      remaining.lastIndexOf("! ", midpoint),
      remaining.lastIndexOf("? ", midpoint),
    );

    let pivot = Math.max(newlineBreak, punctuationBreak);
    if (pivot < MIN_SEGMENT_SPLIT_LENGTH) {
      pivot = midpoint;
    }

    const chunk = remaining.slice(0, pivot).trim();
    if (!chunk.length) {
      break;
    }

    pieces.push({
      ...segment,
      id: `${segment.id}::${String.fromCharCode(97 + counter)}`,
      index: segment.index * 10 + counter,
      text: chunk,
    });
    remaining = remaining.slice(pivot).trimStart();
    counter += 1;
  }

  if (remaining.length) {
    pieces.push({
      ...segment,
      id: `${segment.id}::${String.fromCharCode(97 + counter)}`,
      index: segment.index * 10 + counter,
      text: remaining.trim(),
    });
  }

  return pieces.length ? pieces : [segment];
}

export function mergeDraftSegmentResults(
  original: OriginSegment,
  partialSegments: TranslationDraftAgentSegmentResult[],
): TranslationDraftAgentSegmentResult {
  const prefix = `${original.id}::`;
  const relevant = partialSegments.filter((segment) =>
    segment.segment_id.startsWith(prefix),
  );

  if (!relevant.length) {
    return {
      segment_id: original.id,
      origin_segment: original.text,
      translation_segment: original.text,
      notes: [],
      spanPairs: [
        {
          source_span_id: original.id,
          source_start: 0,
          source_end: original.text.length,
          target_start: 0,
          target_end: original.text.length,
        },
      ],
      candidates: [],
    };
  }

  const translation = relevant
    .map((segment) => segment.translation_segment?.trim() ?? "")
    .filter((value) => value.length)
    .join(" ")
    .trim();

  const notes = relevant.flatMap((segment) => segment.notes ?? []);

  return {
    segment_id: original.id,
    origin_segment: original.text,
    translation_segment: translation || original.text,
    notes,
    spanPairs: [
      {
        source_span_id: original.id,
        source_start: 0,
        source_end: original.text.length,
        target_start: 0,
        target_end: (translation || original.text).length,
      },
    ],
    candidates: [],
  };
}

type AgentMetaBase = {
  verbosity: string;
  reasoningEffort: string;
  maxOutputTokens: number;
  attempts: number;
  retryCount: number;
  truncated: boolean;
  fallbackModelUsed: boolean;
  jsonRepairApplied: boolean;
  attemptHistory?: unknown[];
};

export function mergeAgentMeta<T extends AgentMetaBase>(left: T, right: T): T {
  const merged = {
    verbosity: left.verbosity,
    reasoningEffort: left.reasoningEffort,
    maxOutputTokens: Math.max(left.maxOutputTokens, right.maxOutputTokens),
    attempts: left.attempts + right.attempts,
    retryCount: left.retryCount + right.retryCount,
    truncated: left.truncated || right.truncated,
    fallbackModelUsed: left.fallbackModelUsed || right.fallbackModelUsed,
    jsonRepairApplied: left.jsonRepairApplied || right.jsonRepairApplied,
    attemptHistory: [
      ...(left.attemptHistory ?? []),
      ...(right.attemptHistory ?? []),
    ],
  } as T & { lengthFailures?: unknown };

  const leftLength = (left as { lengthFailures?: unknown[] }).lengthFailures ?? [];
  const rightLength = (right as { lengthFailures?: unknown[] }).lengthFailures ?? [];
  if (leftLength.length || rightLength.length) {
    (merged as { lengthFailures: unknown[] }).lengthFailures = [
      ...leftLength,
      ...rightLength,
    ];
  }

  return merged as T;
}
