import { Types } from "mongoose";

import TranslationDraft from "../models/TranslationDraft";
import TranslationFile from "../models/TranslationFile";
import TranslationSegment from "../models/TranslationSegment";
import { query } from "../db";
import { getStreamRunMetrics } from "../db/streamRunMetrics";
import {
  fetchTranslationStreamMeta,
  type TranslationStreamMeta,
} from "./translationStreamMeta";
import type {
  StageTimelineEntry,
  TranslationSummaryExtras,
} from "./translationSummaryState";
import { translationRunId } from "./translationEvents";

interface StageProgressRow {
  stage: string;
  segments_total: number;
  segments_done: number;
  needs_followup: number;
}

export type TranslationStageId = "draft" | "revise" | "microcheck";

export interface TranslationRunSummaryResponse {
  projectId: string;
  runId: string | null;
  runStatus: "queued" | "running" | "done" | "error";
  runCreatedAt: string | null;
  runCompletedAt: string | null;
  lastEventAt: string | null;
  jobId: string | null;
  sourceFileId: string | null;
  memoryVersion: number | null;
  translation: {
    id: string | null;
    status: "queued" | "running" | "done" | "error";
    createdAt: string | null;
    completedAt: string | null;
    currentStage: TranslationStageId | null;
    stages: Array<{
      stage: TranslationStageId;
      status: "queued" | "running" | "done" | "error";
      startedAt: string | null;
      completedAt: string | null;
    }>;
  };
  workflowRun: {
    runId: string;
    status: string;
    label: string | null;
    startedAt: string | null;
    completedAt: string | null;
    updatedAt: string | null;
  } | null;
  progress: {
    segmentsTotal: number;
    segmentsCompleted: number;
    percent: number;
    byStage: Record<TranslationStageId, {
      segmentsDone: number;
      segmentsTotal: number;
      tokensOut: number;
    }>;
  };
  resilience: {
    downshiftCount: number;
    forcedPaginationCount: number;
    cursorRetryCount: number;
    reconnectLimitReached: boolean;
    reconnectAttempts: number;
  };
  followups: {
    needsFollowupTotal: number;
    byStage: Record<TranslationStageId, number>;
    byReason: {
      guardFail?: number;
      overlength?: number;
      truncation?: number;
    };
  };
  usage: {
    tokensIn: number;
    tokensOut: number;
    costUsd: number | null;
    primaryModel: string | null;
    maxOutputTokens: number | null;
  };
  pagination: {
    hasMore: boolean;
    nextCursor: string | null;
  };
  errors: {
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
  };
  streamMeta: TranslationStreamMeta | null;
  updatedAt: string | null;
  summarySchemaVersion: number;
}

export interface TranslationRunSummaryRequest {
  projectId: string;
  runId?: string | null;
  jobId?: string | null;
}

const DEFAULT_STAGE_KEYS: TranslationStageId[] = [
  "draft",
  "revise",
  "microcheck",
];

const normalizeStageId = (value: string): TranslationStageId | null => {
  if (value === "draft") return "draft";
  if (value === "revise") return "revise";
  if (value === "micro-check" || value === "microcheck") return "microcheck";
  return null;
};

export const timelineStatusToSummaryStatus = (
  status: StageTimelineEntry["status"] | undefined,
): "queued" | "running" | "done" | "error" | null => {
  switch (status) {
    case "queued":
      return "queued";
    case "in_progress":
      return "running";
    case "done":
      return "done";
    case "error":
      return "error";
    default:
      return null;
  }
};

const toSummaryExtras = (
  value: unknown,
): TranslationSummaryExtras => {
  if (!value || typeof value !== "object") {
    return {};
  }
  try {
    return JSON.parse(JSON.stringify(value)) as TranslationSummaryExtras;
  } catch (_error) {
    return value as TranslationSummaryExtras;
  }
};

export const calculatePercentComplete = (
  total: number,
  completed: number,
  microcheckCompleted: boolean,
): number => {
  if (!Number.isFinite(total) || total <= 0) {
    return 0;
  }
  const safeTotal = Math.max(1, Math.floor(total));
  const safeCompleted = Math.max(0, Math.floor(completed));
  const raw = Math.round((safeCompleted / safeTotal) * 100);
  const capped = Math.min(raw, 100);
  return microcheckCompleted ? capped : Math.min(capped, 99);
};

export const buildTranslationStages = (
  stages: Array<{
    stage: TranslationStageId;
    status: "queued" | "running" | "done" | "error";
    timeline: StageTimelineEntry | null;
  }>,
  runStartedAt: string | null,
  runCompletedAt: string | null,
) =>
  stages.map((entry) => ({
    stage: entry.stage,
    status: entry.status,
    startedAt:
      entry.timeline?.startedAt ?? (entry.status !== "queued" ? runStartedAt : null),
    completedAt:
      entry.timeline?.completedAt ??
      (entry.status === "done" ? runCompletedAt : null),
  }));

const toIso = (value: Date | string | null | undefined): string | null => {
  if (!value) return null;
  try {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
  } catch (error) {
    return null;
  }
};

const loadWorkflowRun = async (
  projectId: string,
  jobId: string | null,
) => {
  if (!jobId) return null;
  const { rows } = await query(
    `SELECT run_id, status, label, started_at, completed_at, updated_at
       FROM workflow_runs
      WHERE project_id = $1
        AND type = 'translate'
        AND metadata ->> 'jobId' = $2
      ORDER BY started_at DESC
      LIMIT 1`,
    [projectId, jobId],
  );
  if (!rows.length) return null;
  const row = rows[0] as {
    run_id: string;
    status: string;
    label: string | null;
    started_at: Date | string | null;
    completed_at: Date | string | null;
    updated_at: Date | string | null;
  };
  return {
    runId: row.run_id,
    status: row.status,
    label: row.label ?? null,
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    updatedAt: toIso(row.updated_at),
  };
};

const fetchStageProgress = async (
  projectId: string,
  jobId: string,
): Promise<Map<TranslationStageId, StageProgressRow>> => {
  let rows: StageProgressRow[] = [];
  try {
    const result = await query(
      `SELECT stage,
              COUNT(*) AS segments_total,
              COUNT(*) FILTER (WHERE text_target IS NOT NULL) AS segments_done,
              SUM(CASE WHEN needs_review THEN 1 ELSE 0 END) AS needs_followup
         FROM translation_drafts
        WHERE project_id = $1
          AND job_id = $2
        GROUP BY stage`,
      [projectId, jobId],
    );
    rows = result.rows as StageProgressRow[];
  } catch (error) {
    // eslint-disable-next-line no-console -- surface only during early rollout
    console.warn("[TranslationSummary] failed to load stage progress", {
      projectId,
      jobId,
      error,
    });
    rows = [];
  }
  const map = new Map<TranslationStageId, StageProgressRow>();
  for (const row of rows) {
    const stageId = normalizeStageId(row.stage);
    if (!stageId) continue;
    map.set(stageId, {
      stage: stageId,
      segments_total: Number(row.segments_total ?? 0),
      segments_done: Number(row.segments_done ?? 0),
      needs_followup: Number(row.needs_followup ?? 0),
    });
  }
  return map;
};

const computeStageStatus = (
  progress: StageProgressRow | undefined,
): "queued" | "running" | "done" => {
  if (!progress) return "queued";
  if (progress.segments_total <= 0) {
    return progress.segments_done > 0 ? "running" : "queued";
  }
  if (progress.segments_done >= progress.segments_total) {
    return "done";
  }
  if (progress.segments_done > 0) {
    return "running";
  }
  return "queued";
};

const computeCurrentStage = (
  stageStatuses: Array<{
    stage: TranslationStageId;
    status: "queued" | "running" | "done" | "error";
  }>,
): TranslationStageId | null => {
  for (const entry of stageStatuses) {
    if (entry.status === "running") {
      return entry.stage;
    }
    if (entry.status !== "done") {
      return entry.stage;
    }
  }
  return stageStatuses.length ? stageStatuses[stageStatuses.length - 1].stage : null;
};

const loadTranslationFile = async (
  projectId: string,
  jobId: string,
) => {
  const doc = await TranslationFile.findOne({
    project_id: projectId,
    job_id: jobId,
  })
    .select({
      _id: 1,
      completed_at: 1,
      updated_at: 1,
    })
    .lean();
  if (!doc) return null;
  return {
    id: doc._id instanceof Types.ObjectId ? doc._id.toString() : String(doc._id),
    completedAt: toIso(doc.completed_at ?? null),
    updatedAt: toIso(doc.updated_at ?? null),
  };
};

const loadFollowupSegments = async (
  translationFileId: string | null,
): Promise<number> => {
  if (!translationFileId) return 0;
  try {
    const objectId = new Types.ObjectId(translationFileId);
    const count = await TranslationSegment.countDocuments({
      translation_file_id: objectId,
      "synthesis_notes.needsFollowup": true,
    });
    return Number(count ?? 0);
  } catch (_error) {
    return 0;
  }
};

export async function getTranslationRunSummary(
  params: TranslationRunSummaryRequest,
): Promise<TranslationRunSummaryResponse | null> {
  const projectId = params.projectId;
  let runId: string | null = params.runId ?? null;
  let jobId: string | null = params.jobId ?? null;

  if (!jobId && runId) {
    jobId = runId.startsWith("translation:")
      ? runId.slice("translation:".length)
      : runId;
  }

  if (!runId && jobId) {
    runId = translationRunId(jobId);
  }

  if (!projectId || !jobId) {
    return null;
  }

  const resolvedJobId = jobId as string;
  const resolvedRunId = runId ?? translationRunId(resolvedJobId);
  runId = resolvedRunId;

  const [draftDoc, stageProgressMap, streamMeta, streamRow, workflowRun, fileRecord] =
    await Promise.all([
      TranslationDraft.findOne({
        project_id: projectId,
        job_id: resolvedJobId,
        run_order: 1,
      })
        .select({
          _id: 1,
          status: 1,
          created_at: 1,
          started_at: 1,
          finished_at: 1,
          usage: 1,
          model: 1,
          max_output_tokens: 1,
          metadata: 1,
          updated_at: 1,
        })
        .lean(),
      fetchStageProgress(projectId, resolvedJobId),
      fetchTranslationStreamMeta(runId),
      getStreamRunMetrics(runId),
      loadWorkflowRun(projectId, resolvedJobId),
      loadTranslationFile(projectId, resolvedJobId),
    ]);

  const stageProgress = DEFAULT_STAGE_KEYS.map((stage) => ({
    stage,
    progress: stageProgressMap.get(stage),
  }));

  const extras = toSummaryExtras(streamRow?.extras ?? null);
  const stageTimeline: Partial<Record<TranslationStageId, StageTimelineEntry>> =
    extras.stageTimeline ?? {};

  const stageDetails = stageProgress.map(({ stage, progress }) => {
    const timeline = stageTimeline[stage] ?? null;
    const timelineStatus = timelineStatusToSummaryStatus(timeline?.status);
    const computedStatus = computeStageStatus(progress);
    const status = timelineStatus ?? computedStatus;
    return { stage, status, timeline, progress };
  });

  const stageStatusList = stageDetails.map(({ stage, status }) => ({
    stage,
    status,
  }));

  const currentStage = computeCurrentStage(stageStatusList);

  const segmentsTotalFromProgress = stageProgress.reduce(
    (acc, entry) => Math.max(acc, entry.progress?.segments_total ?? 0),
    0,
  );

  const originSegments = Array.isArray(
    (draftDoc?.metadata as { originSegments?: unknown[] } | undefined)?.originSegments,
  )
    ? (((draftDoc?.metadata as { originSegments?: unknown[] }).originSegments ?? []) as Array<{ id: string }>)
    : [];

  const segmentsTotalFallback = Math.max(
    segmentsTotalFromProgress,
    originSegments.length,
  );
  const segmentsTotal =
    extras.segments?.total !== undefined && extras.segments.total !== null
      ? Number(extras.segments.total) || 0
      : segmentsTotalFallback;

  const lastStageWithProgress = stageProgress
    .slice()
    .reverse()
    .find((entry) => entry.progress && entry.progress.segments_done > 0);

  const segmentsCompletedFallback = lastStageWithProgress
    ? lastStageWithProgress.progress?.segments_done ?? 0
    : 0;

  const segmentsCompleted =
    extras.segments?.processed !== undefined &&
    extras.segments?.processed !== null
      ? Number(extras.segments.processed) || 0
      : segmentsCompletedFallback;

  const microcheckStatus = stageStatusList.find(
    (entry) => entry.stage === "microcheck",
  );
  const microcheckCompleted =
    extras.segments?.microcheckCompleted ??
    (microcheckStatus?.status === "done" ? true : false);

  const percent = calculatePercentComplete(
    segmentsTotal,
    segmentsCompleted,
    microcheckCompleted,
  );

  let followupsByStage: Record<TranslationStageId, number>;
  let followupByReason: Record<string, number>;
  let needsFollowupTotal: number;

  if (extras.followups) {
    followupsByStage = {
      draft: extras.followups.byStage?.draft ?? 0,
      revise: extras.followups.byStage?.revise ?? 0,
      microcheck: extras.followups.byStage?.microcheck ?? 0,
    };
    followupByReason = { ...(extras.followups.byReason ?? {}) };
    needsFollowupTotal = extras.followups.total ?? Object.values(followupsByStage).reduce(
      (acc, value) => acc + value,
      0,
    );
  } else {
    followupsByStage = {
      draft: stageProgressMap.get("draft")?.needs_followup ?? 0,
      revise: stageProgressMap.get("revise")?.needs_followup ?? 0,
      microcheck: stageProgressMap.get("microcheck")?.needs_followup ?? 0,
    };
    const followupTotalFromStages = Object.values(followupsByStage).reduce(
      (acc, value) => acc + value,
      0,
    );
    const followupTotalFromSegments = await loadFollowupSegments(
      fileRecord?.id ?? null,
    );
    needsFollowupTotal = Math.max(
      followupTotalFromStages,
      followupTotalFromSegments,
    );
    followupByReason = {
      guardFail: needsFollowupTotal,
    };
  }

  const pagination = extras.pagination
    ? {
        hasMore: Boolean(extras.pagination.hasMore),
        nextCursor: extras.pagination.nextCursor ?? null,
      }
    : {
        hasMore:
          Boolean(
            streamRow?.extras &&
              (streamRow.extras as { hasMore?: boolean }).hasMore,
          ) || false,
        nextCursor:
          (streamRow?.extras &&
            (streamRow.extras as { nextCursor?: string }).nextCursor) ?? null,
      };

  const reconnectAttemptsFromStream =
    streamMeta?.reconnectAttempts ?? streamRow?.reconnect_attempts ?? 0;
  const reconnectAttempts = Number(
    extras.retry?.reconnectAttempts ?? reconnectAttemptsFromStream ?? 0,
  );
  const reconnectLimitReached = Boolean(
    extras.retry?.limitReached ?? reconnectAttempts > 10,
  );

  const usageTokensIn = streamRow?.tokens_in ?? draftDoc?.usage?.input_tokens ?? 0;
  const usageTokensOut = streamRow?.tokens_out ?? draftDoc?.usage?.output_tokens ?? 0;

  const progressByStage: Record<TranslationStageId, { segmentsDone: number; segmentsTotal: number; tokensOut: number }> = {
    draft: {
      segmentsDone: stageProgressMap.get("draft")?.segments_done ?? 0,
      segmentsTotal: stageProgressMap.get("draft")?.segments_total ?? segmentsTotal,
      tokensOut: draftDoc?.usage?.output_tokens ?? 0,
    },
    revise: {
      segmentsDone: stageProgressMap.get("revise")?.segments_done ?? 0,
      segmentsTotal: stageProgressMap.get("revise")?.segments_total ?? segmentsTotal,
      tokensOut: 0,
    },
    microcheck: {
      segmentsDone: stageProgressMap.get("microcheck")?.segments_done ?? 0,
      segmentsTotal: stageProgressMap.get("microcheck")?.segments_total ?? segmentsTotal,
      tokensOut: 0,
    },
  };

  const streamStatus = streamRow?.status ?? null;

  let runStatus: "queued" | "running" | "done" | "error" = "queued";
  if (streamStatus === "error") {
    runStatus = "error";
  } else if (fileRecord) {
    runStatus = "done";
  } else if (draftDoc?.status === "failed") {
    runStatus = "error";
  } else if (stageStatusList.some((entry) => entry.status === "error")) {
    runStatus = "error";
  } else if (stageStatusList.some((entry) => entry.status === "running")) {
    runStatus = "running";
  } else if (draftDoc?.status === "running") {
    runStatus = "running";
  }

  const translationStatus: "queued" | "running" | "done" | "error" =
    runStatus === "error"
      ? "error"
      : fileRecord
        ? "done"
        : stageStatusList.some((entry) => entry.status === "error")
          ? "error"
        : stageStatusList.some((entry) => entry.status === "running")
          ? "running"
          : "queued";

  const runStartedAt = toIso(draftDoc?.started_at ?? draftDoc?.created_at ?? null);
  const runCompletedAt = fileRecord?.completedAt ?? toIso(draftDoc?.finished_at);

  const translationStages = buildTranslationStages(
    stageDetails,
    runStartedAt,
    runCompletedAt,
  );

  const summary: TranslationRunSummaryResponse = {
    projectId,
    runId,
    runStatus,
    runCreatedAt: runStartedAt,
    runCompletedAt: runCompletedAt,
    lastEventAt:
      streamMeta?.lastEventAt ?? streamMeta?.lastHeartbeatAt ?? toIso(draftDoc?.updated_at ?? null),
    jobId,
    sourceFileId: null,
    memoryVersion: null,
    translation: {
      id: fileRecord?.id ?? null,
      status: translationStatus,
      createdAt: runStartedAt,
      completedAt: runCompletedAt,
      currentStage,
      stages: translationStages,
    },
    workflowRun,
    progress: {
      segmentsTotal,
      segmentsCompleted,
      percent,
      byStage: progressByStage,
    },
    resilience: {
      downshiftCount: streamRow?.downshift_count ?? 0,
      forcedPaginationCount: streamRow?.forced_pagination_count ?? 0,
      cursorRetryCount: streamRow?.cursor_retry_count ?? 0,
      reconnectLimitReached,
      reconnectAttempts,
    },
    followups: {
      needsFollowupTotal,
      byStage: followupsByStage,
      byReason: followupByReason,
    },
    usage: {
      tokensIn: Number(usageTokensIn ?? 0),
      tokensOut: Number(usageTokensOut ?? 0),
      costUsd: streamRow?.cost_usd ? Number(streamRow.cost_usd) : null,
      primaryModel: draftDoc?.model ?? streamRow?.model ?? null,
      maxOutputTokens:
        draftDoc?.max_output_tokens ?? streamRow?.max_output_tokens ?? null,
    },
    pagination: {
      hasMore: pagination.hasMore,
      nextCursor: pagination.nextCursor,
    },
    errors: {
      lastErrorCode: streamRow?.error_code ?? null,
      lastErrorMessage: streamRow?.error_message ?? draftDoc?.error ?? null,
    },
    streamMeta,
    updatedAt:
      streamRow?.updated_at?.toISOString() ?? fileRecord?.updatedAt ?? toIso(draftDoc?.updated_at ?? null),
    summarySchemaVersion: 1,
  };

  return summary;
}
