import { Types } from "mongoose";
import TranslationDraft, {
  type TranslationDraftDocument,
  type TranslationDraftSegmentDocument,
} from "../models/TranslationDraft";
import type { OriginSegment } from "../agents/translation/segmentationAgent";
import type { TranslationDraftAgentResultMeta } from "../agents/translation/translationDraftAgent";

export interface DraftSeed {
  projectId: string;
  jobId: string;
  runOrder: number;
  workflowRunId?: string | null;
  sourceHash: string;
  originSegments: OriginSegment[];
  originText?: string;
  originFilename?: string | null;
  originFileSize?: number | null;
  draftConfig?: {
    model?: string;
    verbosity?: string;
    reasoningEffort?: string;
    maxOutputTokens?: number;
  };
}

export async function ensureQueuedDraft(seed: DraftSeed) {
  const existing = await TranslationDraft.findOne({
    project_id: seed.projectId,
    job_id: seed.jobId,
    run_order: seed.runOrder,
  });
  if (existing) {
    return existing;
  }
  const document = await TranslationDraft.create({
    project_id: seed.projectId,
    job_id: seed.jobId,
    workflow_run_id: seed.workflowRunId ?? null,
    run_order: seed.runOrder,
    source_hash: seed.sourceHash,
    status: "queued",
    metadata: {
      originSegments: seed.originSegments.map((segment) => ({
        id: segment.id,
        text: segment.text,
        paragraphIndex: segment.paragraphIndex,
        sentenceIndex: segment.sentenceIndex,
      })),
      originText: seed.originText ?? null,
      originFilename: seed.originFilename ?? null,
      originFileSize: seed.originFileSize ?? null,
      draftConfig: seed.draftConfig ?? null,
    },
  });
  return document;
}

export async function markDraftRunning(
  draftId: Types.ObjectId | string,
  model?: string | null,
) {
  return TranslationDraft.findByIdAndUpdate(
    draftId,
    {
      $set: {
        status: "running",
        model: model ?? null,
        started_at: new Date(),
        error: null,
      },
    },
    { new: true },
  );
}

export async function completeDraft(
  draftId: Types.ObjectId | string,
  payload: {
    segments: TranslationDraftSegmentDocument[];
    mergedText: string;
    model: string;
    usage: { inputTokens: number; outputTokens: number };
    meta: TranslationDraftAgentResultMeta;
  },
) {
  return TranslationDraft.findByIdAndUpdate(
    draftId,
    {
      $set: {
        status: "succeeded",
        segments: payload.segments,
        merged_text: payload.mergedText,
        model: payload.model,
        temperature: null,
        top_p: null,
        verbosity: payload.meta.verbosity,
        reasoning_effort: payload.meta.reasoningEffort,
        max_output_tokens: payload.meta.maxOutputTokens,
        retry_count: payload.meta.retryCount,
        truncated: payload.meta.truncated,
        fallback_model_used: payload.meta.fallbackModelUsed,
        usage: {
          input_tokens: payload.usage.inputTokens,
          output_tokens: payload.usage.outputTokens,
        },
        "metadata.analysis_meta": payload.meta,
        finished_at: new Date(),
      },
    },
    { new: true },
  );
}

export async function failDraft(
  draftId: Types.ObjectId | string,
  errorMessage: string,
) {
  return TranslationDraft.findByIdAndUpdate(
    draftId,
    {
      $set: {
        status: "failed",
        error: errorMessage,
        finished_at: new Date(),
      },
    },
    { new: true },
  );
}

export async function listSuccessfulDrafts(projectId: string, jobId: string) {
  return TranslationDraft.find({
    project_id: projectId,
    job_id: jobId,
    status: "succeeded",
  })
    .sort({ run_order: 1 })
    .lean();
}

export async function cancelDrafts(jobId: string, reason: string) {
  const now = new Date();
  await TranslationDraft.updateMany(
    {
      job_id: jobId,
      status: { $in: ["queued", "running"] },
    },
    {
      $set: {
        status: "cancelled",
        error: reason,
        finished_at: now,
      },
    },
  );
}

export async function loadDraftsByIds(
  draftIds: Array<string | Types.ObjectId>,
  options: { projectId: string; jobId?: string | null } | null,
) {
  if (!draftIds.length) {
    return [];
  }
  const normalizedIds = draftIds.map((id) =>
    typeof id === "string" ? new Types.ObjectId(id) : id,
  );
  const filter: Record<string, unknown> = {
    _id: { $in: normalizedIds },
  };
  if (options?.projectId) {
    filter.project_id = options.projectId;
  }
  if (options?.jobId) {
    filter.job_id = options.jobId;
  }
  return TranslationDraft.find(filter)
    .sort({ run_order: 1 })
    .lean();
}

export interface TranslationDraftRunSummary {
  id: string;
  projectId: string;
  jobId: string;
  runOrder: number;
  model: string | null;
  verbosity: string | null;
  reasoningEffort: string | null;
  maxOutputTokens: number | null;
  retryCount: number;
  attempts: number | null;
  truncated: boolean;
  fallbackModelUsed: boolean;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
  };
  finishedAt: Date | null;
  updatedAt: Date;
}

export async function listRecentDraftRuns(config: {
  projectId?: string;
  limit?: number;
}): Promise<TranslationDraftRunSummary[]> {
  const filter: Record<string, unknown> = { status: "succeeded" };
  if (config.projectId) {
    filter.project_id = config.projectId;
  }

  const limit = Math.max(1, Math.min(config.limit ?? 50, 200));

  const docs = await TranslationDraft.find(filter)
    .sort({ finished_at: -1, updated_at: -1 })
    .limit(limit)
    .select({
      project_id: 1,
      job_id: 1,
      run_order: 1,
      model: 1,
      verbosity: 1,
      reasoning_effort: 1,
      max_output_tokens: 1,
      retry_count: 1,
      metadata: 1,
      truncated: 1,
      fallback_model_used: 1,
      usage: 1,
      finished_at: 1,
      updated_at: 1,
    })
    .lean();

  return docs.map((doc) => {
    const analysisMeta = (
      (doc.metadata as { analysis_meta?: { attempts?: unknown } } | null | undefined)?.analysis_meta ??
      null
    );

    const attempts =
      analysisMeta && typeof analysisMeta.attempts === "number"
        ? analysisMeta.attempts
        : null;

    return {
      id: doc._id.toString(),
      projectId: doc.project_id,
      jobId: doc.job_id,
      runOrder: doc.run_order,
      model: doc.model ?? null,
      verbosity: doc.verbosity ?? null,
      reasoningEffort: doc.reasoning_effort ?? null,
      maxOutputTokens: doc.max_output_tokens ?? null,
      retryCount: doc.retry_count ?? 0,
      attempts,
      truncated: Boolean(doc.truncated),
      fallbackModelUsed: Boolean(doc.fallback_model_used),
      usage: {
        inputTokens: doc.usage?.input_tokens ?? null,
        outputTokens: doc.usage?.output_tokens ?? null,
      },
      finishedAt: doc.finished_at ?? null,
      updatedAt: doc.updated_at,
    } satisfies TranslationDraftRunSummary;
  });
}

export type { TranslationDraftDocument, TranslationDraftSegmentDocument };
