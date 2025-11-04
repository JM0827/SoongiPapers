import DocumentProfile from "../models/DocumentProfile";
import OriginFile from "../models/OriginFile";
import { query } from "../db";

export type OriginPrepUploadStatus = "missing" | "uploaded";
export type OriginPrepAnalysisStatus =
  | "missing"
  | "running"
  | "stale"
  | "complete";
export type OriginPrepNotesStatus = "missing" | "stale" | "complete";
export type TranslationPrereq = "analysis" | "notes";

export interface OriginProfileJobInfo {
  jobId: string;
  status: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
}

export interface OriginPrepSnapshot {
  projectId: string;
  upload: {
    status: OriginPrepUploadStatus;
    updatedAt: string | null;
    originFileId: string | null;
  };
  analysis: {
    status: OriginPrepAnalysisStatus;
    updatedAt: string | null;
    profileId: string | null;
    originFileId: string | null;
    sourceHash: string | null;
    job: OriginProfileJobInfo | null;
  };
  notes: {
    status: OriginPrepNotesStatus;
    updatedAt: string | null;
    profileId: string | null;
    hasContent: boolean;
  };
  blockingReasons: Array<{
    step: "upload" | "analysis" | "notes";
    status:
      | OriginPrepUploadStatus
      | OriginPrepAnalysisStatus
      | OriginPrepNotesStatus;
    updatedAt: string | null;
    jobId?: string | null;
  }>;
}

type OriginDocLike = {
  _id?: unknown;
  created_at?: Date | string | null;
  updated_at?: Date | string | null;
  [key: string]: unknown;
} | null;

type OriginProfileLike = {
  _id?: unknown;
  created_at?: Date | string | null;
  updated_at?: Date | string | null;
  origin_file_id?: unknown;
  source_hash?: string | null;
  translation_notes?: unknown;
  [key: string]: unknown;
} | null;

interface BuildSnapshotInput {
  projectId: string;
  originDoc: OriginDocLike;
  originProfile: OriginProfileLike;
  latestProfileJob?: OriginProfileJobInfo | null;
}

const RUNNING_JOB_STATUSES = new Set(["queued", "running", "pending"]);

const toIso = (value?: Date | string | null): string | null => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
};

const toMillis = (value?: Date | string | null): number | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isNaN(time) ? null : time;
};

const toId = (value: unknown): string | null => {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && value && "toString" in value) {
    try {
      return (value as { toString(): string }).toString();
    } catch (err) {
      return null;
    }
  }
  return null;
};

const isJobActive = (job: OriginProfileJobInfo | null | undefined) => {
  if (!job?.status) return false;
  return RUNNING_JOB_STATUSES.has(job.status.toLowerCase());
};

export function buildOriginPrepSnapshot({
  projectId,
  originDoc,
  originProfile,
  latestProfileJob = null,
}: BuildSnapshotInput): OriginPrepSnapshot {
  const originFileId = originDoc ? toId((originDoc as any)._id) : null;
  const uploadUpdatedAt = toIso(originDoc?.updated_at ?? null);
  const uploadStatus: OriginPrepUploadStatus = originDoc
    ? "uploaded"
    : "missing";

  const profileId = originProfile ? toId((originProfile as any)._id) : null;
  const profileUpdatedAt = toIso(
    originProfile?.updated_at ?? originProfile?.created_at ?? null,
  );
  const profileOriginFileId = originProfile?.origin_file_id
    ? toId(originProfile.origin_file_id as any)
    : null;

  const originUpdatedMs = toMillis(originDoc?.updated_at ?? null);
  const profileUpdatedMs = toMillis(
    originProfile?.updated_at ?? originProfile?.created_at ?? null,
  );

  let isStale = false;
  if (originDoc && originProfile) {
    if (
      originFileId &&
      profileOriginFileId &&
      profileOriginFileId !== originFileId
    ) {
      isStale = true;
    } else if (
      originUpdatedMs !== null &&
      profileUpdatedMs !== null &&
      profileUpdatedMs < originUpdatedMs
    ) {
      isStale = true;
    }
  }

  const activeJob = latestProfileJob ?? null;
  const jobRunning = isJobActive(activeJob);

  let analysisStatus: OriginPrepAnalysisStatus;
  if (!originProfile) {
    analysisStatus = jobRunning ? "running" : "missing";
  } else if (jobRunning) {
    analysisStatus = "running";
  } else if (isStale) {
    analysisStatus = "stale";
  } else {
    analysisStatus = "complete";
  }

  let notesStatus: OriginPrepNotesStatus;
  if (!originProfile) {
    notesStatus = "missing";
  } else if (isStale || jobRunning) {
    notesStatus = "stale";
  } else {
    notesStatus = "complete";
  }

  const hasNotesContent = Boolean(originProfile?.translation_notes);

  const blockingReasons: OriginPrepSnapshot["blockingReasons"] = [];
  if (uploadStatus !== "uploaded") {
    blockingReasons.push({
      step: "upload",
      status: uploadStatus,
      updatedAt: uploadUpdatedAt,
    });
  }
  if (analysisStatus !== "complete") {
    blockingReasons.push({
      step: "analysis",
      status: analysisStatus,
      updatedAt:
        profileUpdatedAt ??
        activeJob?.updatedAt ??
        activeJob?.createdAt ??
        null,
      jobId: activeJob?.jobId ?? null,
    });
  }
  if (notesStatus !== "complete") {
    blockingReasons.push({
      step: "notes",
      status: notesStatus,
      updatedAt: profileUpdatedAt,
    });
  }

  return {
    projectId,
    upload: {
      status: uploadStatus,
      updatedAt: uploadUpdatedAt,
      originFileId,
    },
    analysis: {
      status: analysisStatus,
      updatedAt: profileUpdatedAt,
      profileId,
      originFileId: profileOriginFileId,
      sourceHash: originProfile?.source_hash ?? null,
      job: activeJob,
    },
    notes: {
      status: notesStatus,
      updatedAt: profileUpdatedAt,
      profileId,
      hasContent: hasNotesContent,
    },
    blockingReasons,
  };
}

async function loadLatestOriginProfileJob(
  projectId: string,
): Promise<OriginProfileJobInfo | null> {
  try {
    const { rows } = await query(
      `SELECT id, status, created_at, updated_at, finished_at, document_id
         FROM jobs
        WHERE project_id = $1 AND type = 'profile'
        ORDER BY created_at DESC
        LIMIT 25`,
      [projectId],
    );
    for (const row of rows) {
      const payload =
        typeof row.document_id === "string"
          ? safeParsePayload(row.document_id)
          : null;
      if (payload?.variant === "origin") {
        return {
          jobId: row.id,
          status: row.status ?? null,
          createdAt: toIso(row.created_at ?? null),
          updatedAt: toIso(row.updated_at ?? null),
          finishedAt: toIso(row.finished_at ?? null),
        };
      }
    }
  } catch (err) {
    console.warn("[originPrep] Failed to load profile job", err);
  }
  return null;
}

const safeParsePayload = (raw: string): { variant?: string } | null => {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as { variant?: string };
  } catch (err) {
    return null;
  }
};

export async function loadOriginPrepSnapshot({
  projectId,
  originDoc,
  originProfile,
}: {
  projectId: string;
  originDoc?: OriginDocLike;
  originProfile?: OriginProfileLike;
}): Promise<OriginPrepSnapshot> {
  let resolvedOriginDoc: OriginDocLike = originDoc ?? null;
  if (!resolvedOriginDoc) {
    try {
      resolvedOriginDoc = await OriginFile.findOne({ project_id: projectId })
        .sort({ updated_at: -1 })
        .lean()
        .exec();
    } catch (err) {
      resolvedOriginDoc = null;
    }
  }

  let resolvedOriginProfile: OriginProfileLike = originProfile ?? null;
  if (!resolvedOriginProfile) {
    try {
      resolvedOriginProfile = await DocumentProfile.findOne({
        project_id: projectId,
        type: "origin",
      })
        .sort({ version: -1 })
        .lean()
        .exec();
    } catch (err) {
      resolvedOriginProfile = null;
    }
  }

  const latestProfileJob = await loadLatestOriginProfileJob(projectId);

  return buildOriginPrepSnapshot({
    projectId,
    originDoc: resolvedOriginDoc,
    originProfile: resolvedOriginProfile,
    latestProfileJob,
  });
}

export function evaluateTranslationPrereqs(
  snapshot: OriginPrepSnapshot,
): TranslationPrereq[] {
  const unmet: TranslationPrereq[] = [];
  if (snapshot.analysis.status !== "complete") {
    unmet.push("analysis");
  }
  if (snapshot.notes.status !== "complete") {
    unmet.push("notes");
  }
  return unmet;
}

export async function ensureTranslationPrereqs(projectId: string) {
  const originPrep = await loadOriginPrepSnapshot({ projectId });
  const unmet = evaluateTranslationPrereqs(originPrep);
  return { originPrep, unmet };
}
