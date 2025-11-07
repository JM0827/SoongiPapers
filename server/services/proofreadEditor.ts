import { Types } from "mongoose";
import TranslationFile from "../models/TranslationFile";
import TranslationSegment, {
  type TranslationSegmentDocument,
} from "../models/TranslationSegment";
import Proofreading from "../models/Proofreading";
import OriginFile from "../models/OriginFile";
import { emitProofreadEditorUpdate } from "./proofreadEditorEvents";
import { translationRunId } from "./translationEvents";
import {
  getCanonicalCacheState,
  type CanonicalCacheState,
} from "./translation/canonicalCache";

export interface ProofreadEditorDatasetSummary {
  id: string;
  projectId: string;
  translationFileId: string;
  jobId: string | null;
  variant: string | null;
  source: string | null;
  updatedAt: string | null;
  segmentCount: number;
  originVersion: string | null;
  translationVersion: string | null;
  proofreadingId: string | null;
  proofreadingStage: string | null;
  proofreadUpdatedAt: string | null;
}

export interface ProofreadEditorSegmentPayload {
  segmentId: string;
  segmentIndex: number;
  origin: {
    text: string;
    lastSavedAt: string | null;
  };
  translation: {
    text: string;
    lastSavedAt: string | null;
  };
  issues: string[];
  spans: Array<{ issueId: string; start: number; end: number }>;
  annotations: unknown[];
}

export interface ProofreadEditorResponse {
  dataset: ProofreadEditorDatasetSummary;
  segments: ProofreadEditorSegmentPayload[];
  issues: unknown[];
  issueAssignments: Record<string, string[]>;
  versions: {
    documentVersion: string;
    translationVersion: string;
  };
  featureToggles: Record<string, boolean>;
  canonicalCacheState: CanonicalCacheState;
}

export interface BuildProofreadEditorDatasetParams {
  projectId: string;
  jobId?: string | null;
  translationFileId?: string | null;
}

const toIsoString = (value: Date | null | undefined): string | null =>
  value ? value.toISOString() : null;

const ensureObjectId = (value: string | Types.ObjectId): Types.ObjectId =>
  value instanceof Types.ObjectId ? value : new Types.ObjectId(value);

const normalizeJobId = (value: unknown): string | null => {
  if (typeof value === "string" && value.trim().length) {
    return value.trim();
  }
  return null;
};

const resolveCanonicalCacheStateForJob = async (
  jobId?: string | null,
): Promise<CanonicalCacheState> => {
  const normalized = normalizeJobId(jobId);
  if (!normalized) {
    return "missing";
  }
  const runId = translationRunId(normalized);
  const snapshot = await getCanonicalCacheState({ runId });
  return snapshot.state;
};

export interface ProofreadEditorPatchSegmentInput {
  segmentId: string;
  column: "origin" | "translation";
  text: string;
}

export interface ProofreadEditorPatchPayload {
  projectId: string;
  translationFileId: string;
  documentVersion: string;
  segments: ProofreadEditorPatchSegmentInput[];
  jobId?: string | null;
  clientMutationId?: string | null;
}

export interface ProofreadEditorPatchResponse extends ProofreadEditorResponse {
  clientMutationId?: string | null;
}

export async function buildProofreadEditorDataset(
  params: BuildProofreadEditorDatasetParams,
): Promise<ProofreadEditorResponse> {
  const { projectId, jobId = null, translationFileId = null } = params;

  let translationFile = null;

  if (translationFileId) {
    if (!Types.ObjectId.isValid(translationFileId)) {
      throw new Error("Invalid translationFileId");
    }
    translationFile = await TranslationFile.findOne({
      _id: ensureObjectId(translationFileId),
      project_id: projectId,
    }).exec();
  }

  if (!translationFile && jobId) {
    translationFile = await TranslationFile.findOne({
      project_id: projectId,
      job_id: jobId,
    }).exec();
  }

  if (!translationFile) {
    translationFile = await TranslationFile.findOne({
      project_id: projectId,
      is_final: true,
    })
      .sort({ completed_at: -1 })
      .exec();
  }

  if (!translationFile) {
    const originDoc = await OriginFile.findOne({ project_id: projectId })
      .sort({ updated_at: -1 })
      .exec();

    if (!originDoc) {
      throw new Error(
        "Translation file not found for proofread editor dataset",
      );
    }

    const originText = originDoc.text_content ?? "";
    const originSegments = buildLightweightOriginSegments(originText);

    const documentVersion =
      toIsoString(originDoc.updated_at) ?? `${Date.now()}`;

    const segmentPayloads: ProofreadEditorSegmentPayload[] = originSegments.map(
      (segment) => ({
        segmentId: segment.id,
        segmentIndex: segment.index,
        origin: {
          text: segment.text,
          lastSavedAt: toIsoString(originDoc.updated_at),
        },
        translation: {
          text: "",
          lastSavedAt: null,
        },
        issues: [],
        spans: [],
        annotations: [],
      }),
    );

    const datasetId = `origin-${originDoc._id.toString()}`;
    const issueAssignments = segmentPayloads.reduce<Record<string, string[]>>(
      (acc, segment) => {
        acc[segment.segmentId] = [];
        return acc;
      },
      {},
    );

    const dataset: ProofreadEditorDatasetSummary = {
      id: datasetId,
      projectId,
      translationFileId: datasetId,
      jobId: originDoc.job_id ?? null,
      variant: "origin-only",
      source: "origin_file",
      updatedAt: toIsoString(originDoc.updated_at),
      segmentCount: segmentPayloads.length,
      originVersion: toIsoString(originDoc.updated_at),
      translationVersion: null,
      proofreadingId: null,
      proofreadingStage: null,
      proofreadUpdatedAt: null,
    };

    const canonicalCacheState = await resolveCanonicalCacheStateForJob(jobId);

    return {
      dataset,
      segments: segmentPayloads,
      issues: [],
      issueAssignments,
      versions: {
        documentVersion,
        translationVersion: documentVersion,
      },
      featureToggles: {
        originOnly: true,
        readOnly: true,
      },
      canonicalCacheState,
    };
  }

  const fileId = translationFile._id.toString();
  const fileJobId = translationFile.job_id ?? null;

  const segments = await TranslationSegment.find({
    project_id: projectId,
    translation_file_id: translationFile._id,
    variant: "final",
  })
    .sort({ segment_index: 1 })
    .exec();

  const proofreadDoc = fileJobId
    ? await Proofreading.findOne({ project_id: projectId, job_id: fileJobId })
        .sort({ updated_at: -1 })
        .exec()
    : null;

  const documentVersion =
    toIsoString(translationFile.updated_at) ?? `${Date.now()}`;

  const segmentPayloads: ProofreadEditorSegmentPayload[] = segments.map(
    (segment) => ({
      segmentId: segment.segment_id || `${segment.segment_index}`,
      segmentIndex: segment.segment_index,
      origin: {
        text: segment.origin_segment,
        lastSavedAt: toIsoString(segment.updated_at),
      },
      translation: {
        text: segment.translation_segment,
        lastSavedAt: toIsoString(segment.updated_at),
      },
      issues: [],
      spans: [],
      annotations: [],
    }),
  );

  const issueAssignments = segmentPayloads.reduce<Record<string, string[]>>(
    (acc, segment) => {
      acc[segment.segmentId] = [];
      return acc;
    },
    {},
  );

  const dataset: ProofreadEditorDatasetSummary = {
    id: fileId,
    projectId,
    translationFileId: fileId,
    jobId: fileJobId,
    variant: translationFile.variant ?? null,
    source: translationFile.source_hash ? "translation_file" : null,
    updatedAt: toIsoString(translationFile.updated_at),
    segmentCount: segmentPayloads.length,
    originVersion: toIsoString(translationFile.updated_at),
    translationVersion: toIsoString(translationFile.updated_at),
    proofreadingId: proofreadDoc?._id ? proofreadDoc._id.toString() : null,
    proofreadingStage: proofreadDoc?.status ?? null,
    proofreadUpdatedAt: toIsoString(proofreadDoc?.updated_at ?? null),
  };

  const translationJobId =
    normalizeJobId((translationFile.job_id as unknown as string | undefined) ?? jobId) ??
    null;
  const canonicalCacheState = await resolveCanonicalCacheStateForJob(
    translationJobId,
  );

  return {
    dataset,
    segments: segmentPayloads,
    issues: [],
    issueAssignments,
    versions: {
      documentVersion,
      translationVersion: documentVersion,
    },
    featureToggles: {},
    canonicalCacheState,
  };
}

const joinSegments = (values: TranslationSegmentDocument[]): string =>
  values
    .sort((a, b) => a.segment_index - b.segment_index)
    .map((segment) => segment.translation_segment)
    .join("\n\n");

const joinOriginSegments = (values: TranslationSegmentDocument[]): string =>
  values
    .sort((a, b) => a.segment_index - b.segment_index)
    .map((segment) => segment.origin_segment)
    .join("\n\n");

const sameInstant = (
  expected: string | null,
  actual: Date | null | undefined,
) => {
  if (!expected) return false;
  if (!actual) return false;
  try {
    const expectedDate = new Date(expected);
    return expectedDate.getTime() === actual.getTime();
  } catch (error) {
    return false;
  }
};

export async function saveProofreadEditorSegments(
  payload: ProofreadEditorPatchPayload,
): Promise<ProofreadEditorPatchResponse> {
  const {
    projectId,
    translationFileId,
    documentVersion,
    segments,
    jobId = null,
    clientMutationId = null,
  } = payload;

  if (!Types.ObjectId.isValid(translationFileId)) {
    throw new Error("Invalid translationFileId");
  }

  if (!segments.length) {
    throw new Error("No segments provided");
  }

  const translationFile = await TranslationFile.findOne({
    _id: ensureObjectId(translationFileId),
    project_id: projectId,
  }).exec();

  if (!translationFile) {
    throw new Error("Translation file not found");
  }

  if (
    documentVersion &&
    !sameInstant(documentVersion, translationFile.updated_at as Date)
  ) {
    const currentVersion = translationFile.updated_at
      ? translationFile.updated_at.toISOString()
      : null;
    const conflict = new Error("Document version conflict");
    (conflict as Error & { status?: number; details?: unknown }).status = 409;
    (conflict as Error & { status?: number; details?: unknown }).details = {
      documentVersion: currentVersion,
    };
    throw conflict;
  }

  const segmentIds = Array.from(
    new Set(segments.map((segment) => segment.segmentId)),
  );

  const segmentDocs = await TranslationSegment.find({
    project_id: projectId,
    translation_file_id: translationFile._id,
    variant: "final",
    segment_id: { $in: segmentIds },
  }).exec();

  if (segmentDocs.length !== segmentIds.length) {
    throw new Error("One or more segments could not be found");
  }

  const now = new Date();

  const segmentById = new Map<string, (typeof segmentDocs)[number]>();
  segmentDocs.forEach((segmentDoc) => {
    segmentById.set(segmentDoc.segment_id, segmentDoc);
  });

  for (const segmentInput of segments) {
    const target = segmentById.get(segmentInput.segmentId);
    if (!target) {
      throw new Error(`Segment ${segmentInput.segmentId} not found`);
    }
    if (segmentInput.column === "origin") {
      target.origin_segment = segmentInput.text;
    } else {
      target.translation_segment = segmentInput.text;
    }
    target.updated_at = now;
    await target.save();
  }

  // Refresh collections for aggregated text rebuild
  const updatedSegments = await TranslationSegment.find({
    project_id: projectId,
    translation_file_id: translationFile._id,
    variant: "final",
  })
    .sort({ segment_index: 1 })
    .exec();

  const aggregatedTranslation = joinSegments(updatedSegments);
  const aggregatedOrigin = joinOriginSegments(updatedSegments);

  translationFile.translated_content = aggregatedTranslation;
  translationFile.origin_content =
    aggregatedOrigin || translationFile.origin_content;
  translationFile.updated_at = now;
  await translationFile.save();

  if (jobId) {
    await Proofreading.updateMany(
      { project_id: projectId, job_id: jobId },
      {
        $set: {
          translated_text: aggregatedTranslation,
          updated_at: now,
        },
      },
    ).exec();
  }

  const response = await buildProofreadEditorDataset({
    projectId,
    jobId,
    translationFileId,
  });

  const newDocumentVersion = response.versions.documentVersion;

  emitProofreadEditorUpdate({
    projectId,
    translationFileId,
    jobId,
    documentVersion: newDocumentVersion,
    clientMutationId: clientMutationId ?? null,
    emittedAt: now.toISOString(),
  });

  return {
    ...response,
    clientMutationId,
  };
}

function buildLightweightOriginSegments(
  originText: string,
): Array<{ id: string; index: number; text: string }> {
  const normalized = typeof originText === "string" ? originText : "";
  const trimmed = normalized.trim();
  if (!trimmed.length) {
    return [];
  }

  const blocks = trimmed
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length);

  const segments = (blocks.length ? blocks : [trimmed]).map((block, index) => ({
    id: `seg-${String(index + 1).padStart(4, "0")}`,
    index,
    text: block,
  }));

  return segments;
}
