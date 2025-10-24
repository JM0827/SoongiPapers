import { Types } from "mongoose";
import TranslationDraft, {
  type TranslationDraftDocument,
  type TranslationDraftSegmentDocument,
} from "../models/TranslationDraft";
import type { OriginSegment } from "../agents/translation/segmentationAgent";

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
    temperature?: number;
    topP?: number;
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
    temperature: number;
    topP: number;
    usage: { inputTokens: number; outputTokens: number };
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
        temperature: payload.temperature,
        top_p: payload.topP,
        usage: {
          input_tokens: payload.usage.inputTokens,
          output_tokens: payload.usage.outputTokens,
        },
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

export type { TranslationDraftDocument, TranslationDraftSegmentDocument };
