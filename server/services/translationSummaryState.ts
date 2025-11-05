import { getStreamRunMetrics } from "../db/streamRunMetrics";
import {
  recordTranslationMetricsSnapshot,
  type TranslationMetricsSnapshot,
} from "./translationStreamMeta";

export type TranslationStageKey = "draft" | "revise" | "microcheck";

export interface StageTimelineEntry {
  status: "queued" | "in_progress" | "done" | "error";
  startedAt: string | null;
  completedAt: string | null;
  itemCount: number | null;
  updatedAt: string;
}

export interface TranslationSummaryExtras {
  stageTimeline?: Partial<Record<TranslationStageKey, StageTimelineEntry>>;
  segments?: {
    total?: number | null;
    processed?: number | null;
    microcheckCompleted?: boolean | null;
    updatedAt?: string;
  };
  followups?: {
    total: number;
    byStage: Record<TranslationStageKey, number>;
    byReason: Record<string, number>;
    updatedAt?: string;
  };
  pagination?: {
    hasMore: boolean;
    nextCursor: string | null;
    stage: string | null;
    updatedAt?: string;
  };
  retry?: {
    limitReached?: boolean;
    reconnectAttempts?: number;
    updatedAt?: string;
  };
}

const normalizeStageKey = (value: string): TranslationStageKey | null => {
  if (value === "draft") return "draft";
  if (value === "revise") return "revise";
  if (value === "micro-check" || value === "microcheck") return "microcheck";
  return null;
};

const cloneExtras = (
  extras: Record<string, unknown> | null | undefined,
): TranslationSummaryExtras => {
  if (!extras) return {};
  try {
    return JSON.parse(JSON.stringify(extras)) as TranslationSummaryExtras;
  } catch (_error) {
    return { ...(extras as TranslationSummaryExtras) };
  }
};

export const updateStageTimeline = async (params: {
  projectId: string | null;
  runId: string;
  stage: string;
  status: "queued" | "in_progress" | "done" | "error";
  itemCount?: number | null;
}): Promise<void> => {
  const stageKey = normalizeStageKey(params.stage);
  if (!stageKey) return;
  const existing = await getStreamRunMetrics(params.runId);
  const extras = cloneExtras(existing?.extras ?? {});
  const nowIso = new Date().toISOString();
  const timeline: Partial<Record<TranslationStageKey, StageTimelineEntry>> = {
    ...(extras.stageTimeline ?? {}),
  };
  const entry = timeline[stageKey] ?? {
    status: "queued" as const,
    startedAt: null,
    completedAt: null,
    itemCount: null,
    updatedAt: nowIso,
  };

  if (params.status === "in_progress" && !entry.startedAt) {
    entry.startedAt = nowIso;
  }
  if ((params.status === "done" || params.status === "error") && !entry.completedAt) {
    entry.completedAt = nowIso;
  }

  entry.status = params.status;
  entry.updatedAt = nowIso;
  if (typeof params.itemCount === "number") {
    entry.itemCount = params.itemCount;
  }
  timeline[stageKey] = entry;
  extras.stageTimeline = timeline;

  const snapshot: TranslationMetricsSnapshot = {
    runId: params.runId,
    projectId: params.projectId,
    extras: extras as Record<string, unknown>,
  };
  await recordTranslationMetricsSnapshot(snapshot, {
    existing,
    mergeExtras: false,
  });
};

export const updateSegmentsMetrics = async (params: {
  projectId: string | null;
  runId: string;
  total?: number | null;
  processed?: number | null;
  microcheckCompleted?: boolean;
}): Promise<void> => {
  const existing = await getStreamRunMetrics(params.runId);
  const extras = cloneExtras(existing?.extras ?? {});
  const nowIso = new Date().toISOString();
  extras.segments = {
    ...(extras.segments ?? {}),
    updatedAt: nowIso,
  };
  if (params.total !== undefined) {
    extras.segments.total = params.total;
  }
  if (params.processed !== undefined) {
    extras.segments.processed = params.processed;
  }
  if (params.microcheckCompleted !== undefined) {
    extras.segments.microcheckCompleted = params.microcheckCompleted;
  }

  const snapshot: TranslationMetricsSnapshot = {
    runId: params.runId,
    projectId: params.projectId,
    extras: extras as Record<string, unknown>,
  };
  await recordTranslationMetricsSnapshot(snapshot, {
    existing,
    mergeExtras: false,
  });
};

export const updateFollowupMetrics = async (params: {
  projectId: string | null;
  runId: string;
  byStage: Record<TranslationStageKey, number>;
  byReason: Record<string, number>;
}): Promise<void> => {
  const existing = await getStreamRunMetrics(params.runId);
  const extras = cloneExtras(existing?.extras ?? {});
  const total = Object.values(params.byStage).reduce(
    (acc, value) => acc + Math.max(0, value ?? 0),
    0,
  );
  extras.followups = {
    total,
    byStage: {
      draft: params.byStage.draft ?? 0,
      revise: params.byStage.revise ?? 0,
      microcheck: params.byStage.microcheck ?? 0,
    },
    byReason: { ...params.byReason },
    updatedAt: new Date().toISOString(),
  };

  const snapshot: TranslationMetricsSnapshot = {
    runId: params.runId,
    projectId: params.projectId,
    extras: extras as Record<string, unknown>,
  };
  await recordTranslationMetricsSnapshot(snapshot, {
    existing,
    mergeExtras: false,
  });
};

export const updatePaginationMetrics = async (params: {
  projectId: string | null;
  runId: string;
  hasMore: boolean;
  nextCursor: string | null;
  stage?: string | null;
}): Promise<void> => {
  const existing = await getStreamRunMetrics(params.runId);
  const extras = cloneExtras(existing?.extras ?? {});
  extras.pagination = {
    hasMore: Boolean(params.hasMore),
    nextCursor: params.nextCursor ?? null,
    stage: params.stage ?? null,
    updatedAt: new Date().toISOString(),
  };

  const snapshot: TranslationMetricsSnapshot = {
    runId: params.runId,
    projectId: params.projectId,
    extras: extras as Record<string, unknown>,
  };
  await recordTranslationMetricsSnapshot(snapshot, {
    existing,
    mergeExtras: false,
  });
};
