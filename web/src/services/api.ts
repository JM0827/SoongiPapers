import type {
  ChatAction,
  ChatMessagePayload,
  ChatResponse,
  ChatStreamCompleteEvent,
  ChatStreamEvent,
  ChatLogRequest,
  ChatHistoryItem,
  EbookResponse,
  CoverInfo,
  CoverStatus,
  CoverAssetInfo,
  CoverAssetRole,
  CoverSetInfo,
  EbookDetails,
  EbookDistributionInfo,
  ProjectTranslationOption,
  JobSummary,
  ProjectContent,
  ProjectUsageResponse,
  ProjectSummary,
  DocumentProfileSummary,
  ProjectContextSnapshotPayload,
  QualityAssessmentResultPayload,
  UserProfile,
  WorkflowSummary,
  WorkflowRunRecord,
  TranslationDraftSummary,
  TranslationDraftAdminRun,
  ProofreadEditorResponse,
  ProofreadEditorPatchPayload,
  ProofreadEditorPatchResponse,
  ProofreadEditorConflictResponse,
  ProofreadEditorStreamEvent,
  TranslationStageDraftResponse,
  TranslationStageKey,
  EditingSelectionPayload,
  EditingSuggestionResponse,
  ProofreadingLogEntry,
  ProofreadRunSummary,
  TranslationRunSummary,
  CanonicalCacheState,
} from "../types/domain";
import type { ModelListResponse } from "../types/model";
import { streamNdjson } from "./sse";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

const defaultHeaders = (token?: string) =>
  ({
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }) as const;

export type TranslationStreamEvent = {
  type: string;
  data?: unknown;
  [key: string]: unknown;
};

export type ProofreadStreamEvent = {
  type: string;
  data?: unknown;
  [key: string]: unknown;
};

export interface ProofreadItemsFetchResponse {
  events: ProofreadStreamEvent[];
  nextCursor: string | null;
  hasMore: boolean;
  total: number;
}

export interface TranslationItemsFetchResponse {
  events: TranslationStreamEvent[];
  nextCursor: string | null;
  hasMore: boolean;
  total: number;
  canonicalCacheState?: CanonicalCacheState;
}

export type QualityStreamStartEvent = {
  type: "start";
  totalChunks: number;
  model: string;
  params: {
    chunkSize: number;
    overlap: number;
    maxOutputTokens: number;
    maxOutputTokensCap: number;
    concurrency: number;
  };
};

export type QualityStreamChunkStartEvent = {
  type: "chunk-start";
  index: number;
  total: number;
  sourceLength: number;
  translatedLength: number;
  maxOutputTokens: number;
  pairCount?: number;
  overlapPairCount?: number;
  sourceTokens?: number;
  translatedTokens?: number;
};

export type QualityStreamChunkRetryEvent = {
  type: "chunk-retry";
  index: number;
  from: number;
  to: number;
};

export type QualityStreamChunkCompleteEvent = {
  type: "chunk-complete";
  index: number;
  total: number;
  durationMs: number;
  requestId?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  maxOutputTokensUsed: number;
  result: QualityAssessmentResultPayload;
  fallbackApplied?: boolean;
  missingFields?: string[];
  attempts?: number;
  preview?: string | null;
  pairCount?: number;
  overlapPairCount?: number;
  sourceTokens?: number;
  translatedTokens?: number;
  truncated?: boolean;
};

export type QualityStreamChunkPartialEvent = {
  type: "chunk-partial";
  index: number;
  total: number;
  attempt: number;
  missingFields: string[];
  requestId?: string;
  preview?: string | null;
  fallbackApplied: boolean;
};

export type QualityStreamChunkErrorEvent = {
  type: "chunk-error";
  index: number;
  message: string;
  error?: unknown;
};

export type QualityStreamProgressEvent = {
  type: "progress";
  completed: number;
  total: number;
};

export type QualityStreamCompleteEvent = {
  type: "complete";
  result: QualityAssessmentResultPayload;
};

export type QualityStreamErrorEvent = {
  type: "error";
  message: string;
};

export type QualityStreamEvent =
  | QualityStreamStartEvent
  | QualityStreamChunkStartEvent
  | QualityStreamChunkRetryEvent
  | QualityStreamChunkCompleteEvent
  | QualityStreamChunkPartialEvent
  | QualityStreamChunkErrorEvent
  | QualityStreamProgressEvent
  | QualityStreamCompleteEvent
  | QualityStreamErrorEvent;

type UploadOriginResponse = {
  success: boolean;
  origin: {
    id: string;
    updated_at: string;
    file_size: number;
    filename: string;
    content?: string;
    metadata: {
      extractor: string | null;
      wordCount: number | null;
      characterCount: number | null;
      mimeType: string | null;
      extension: string | null;
    };
  };
};

type QualityHistoryResponse = {
  data?: {
    assessments?: unknown[];
  };
  assessments?: unknown[];
};

export class ApiError<TPayload = unknown> extends Error {
  status: number;
  payload?: TPayload;

  constructor(message: string, status: number, payload?: TPayload) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let raw = "";
    try {
      raw = await res.text();
    } catch {
      raw = "";
    }

    let payload: unknown = undefined;
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = raw;
      }
    }

    let message = res.statusText;
    if (payload && typeof payload === "object") {
      const errorValue = (payload as { error?: unknown; message?: unknown })
        .error;
      const messageValue = (payload as { error?: unknown; message?: unknown })
        .message;
      if (typeof errorValue === "string" && errorValue.trim()) {
        message = errorValue.trim();
      } else if (typeof messageValue === "string" && messageValue.trim()) {
        message = messageValue.trim();
      }
    } else if (typeof payload === "string" && payload.trim()) {
      message = payload.trim();
    }

    throw new ApiError(message || res.statusText, res.status, payload);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

interface NormalizedBatch {
  id: string;
  batch_index: number;
  status: string;
  started_at?: string;
  finished_at?: string;
  error?: string;
}

async function handleWrapped<T>(res: Response): Promise<T> {
  const payload = await handle<unknown>(res);
  if (isRecord(payload) && "data" in payload) {
    const dataValue = (payload as { data?: unknown }).data;
    if (dataValue !== undefined) {
      return dataValue as T;
    }
  }
  return payload as T;
}

const normalizeJob = (job: unknown): JobSummary => {
  if (!isRecord(job)) {
    return {
      id: "",
      type: "translate",
      status: "unknown",
    } as JobSummary;
  }

  const batches: NormalizedBatch[] | undefined = Array.isArray(job.batches)
    ? job.batches
        .map((batch): NormalizedBatch | null => {
          if (!isRecord(batch)) return null;
          return {
            id: String(batch.id ?? ""),
            batch_index: Number(batch.batch_index ?? 0),
            status: typeof batch.status === "string" ? batch.status : "unknown",
            started_at:
              typeof batch.started_at === "string"
                ? batch.started_at
                : undefined,
            finished_at:
              typeof batch.finished_at === "string"
                ? batch.finished_at
                : undefined,
            error: typeof batch.error === "string" ? batch.error : undefined,
          };
        })
        .filter((batch): batch is NormalizedBatch => Boolean(batch))
    : undefined;

  const drafts = Array.isArray(job.drafts)
    ? job.drafts
        .reduce<TranslationDraftSummary[]>((acc, draft) => {
          if (!isRecord(draft)) return acc;
          const status =
            typeof draft.status === "string" ? draft.status : "queued";
          const runOrder = Number.isFinite(draft.runOrder)
            ? Number(draft.runOrder)
            : Number.isFinite(draft.run_order)
              ? Number(draft.run_order)
              : 0;

          const normalized: TranslationDraftSummary = {
            id: String(draft.id ?? ""),
            runOrder,
            status:
              status === "running" ||
              status === "succeeded" ||
              status === "failed" ||
              status === "cancelled"
                ? (status as TranslationDraftSummary["status"])
                : "queued",
            startedAt:
              typeof draft.started_at === "string"
                ? draft.started_at
                : typeof draft.startedAt === "string"
                  ? draft.startedAt
                  : null,
            finishedAt:
              typeof draft.finished_at === "string"
                ? draft.finished_at
                : typeof draft.finishedAt === "string"
                  ? draft.finishedAt
                  : null,
            error:
              typeof draft.error === "string"
                ? draft.error
                : draft.error === null
                  ? null
                  : undefined,
            model: typeof draft.model === "string" ? draft.model : null,
            temperature: Number.isFinite(draft.temperature)
              ? Number(draft.temperature)
              : null,
            topP: Number.isFinite(draft.topP)
              ? Number(draft.topP)
              : Number.isFinite(draft.top_p)
                ? Number(draft.top_p)
                : null,
          };

          if (!normalized.id || normalized.runOrder <= 0) {
            return acc;
          }

          acc.push(normalized);
          return acc;
        }, [])
        .sort((a, b) => a.runOrder - b.runOrder)
    : undefined;

  const finalTranslation = isRecord(job.finalTranslation)
    ? {
        id: job.finalTranslation.id ? String(job.finalTranslation.id) : "",
        projectId: job.finalTranslation.project_id
          ? String(job.finalTranslation.project_id)
          : job.finalTranslation.projectId
            ? String(job.finalTranslation.projectId)
            : null,
        jobId: job.finalTranslation.job_id
          ? String(job.finalTranslation.job_id)
          : job.finalTranslation.jobId
            ? String(job.finalTranslation.jobId)
            : null,
        completedAt:
          typeof job.finalTranslation.completed_at === "string"
            ? job.finalTranslation.completed_at
            : typeof job.finalTranslation.completedAt === "string"
              ? job.finalTranslation.completedAt
              : null,
        segments: Number.isFinite(job.finalTranslation.segments)
          ? Number(job.finalTranslation.segments)
          : null,
        sourceHash:
          typeof job.finalTranslation.source_hash === "string"
            ? job.finalTranslation.source_hash
            : typeof job.finalTranslation.sourceHash === "string"
              ? job.finalTranslation.sourceHash
              : null,
      }
    : undefined;

  let sequential: JobSummary["sequential"] = null;
  if (job.sequential && isRecord(job.sequential)) {
    type GuardFinding = {
      type: string;
      summary: string;
      ok?: boolean;
      severity?: string;
      segmentId?: string;
      details?: Record<string, unknown> | null;
    };
    type GuardedSegment = {
      segmentIndex: number;
      segmentId: string;
      guards: Record<string, unknown> | null;
      guardFindings: GuardFinding[];
    };

    const stageCountsSource = job.sequential.stageCounts;
    const stageCounts: Record<string, number> = {};
    if (isRecord(stageCountsSource)) {
      for (const [key, value] of Object.entries(stageCountsSource)) {
        stageCounts[key] = Number(value ?? 0);
      }
    }

    const guardFailuresSource = job.sequential.guardFailures;
    const guardFailures: Record<string, number> = {};
    if (isRecord(guardFailuresSource)) {
      for (const [key, value] of Object.entries(guardFailuresSource)) {
        guardFailures[key] = Number(value ?? 0);
      }
    }

    const flaggedSegmentsRaw = Array.isArray(job.sequential.flaggedSegments)
      ? (job.sequential.flaggedSegments as unknown[])
      : [];

    const flaggedSegments = flaggedSegmentsRaw.reduce<GuardedSegment[]>(
      (acc, segment) => {
        if (!isRecord(segment)) {
          return acc;
        }

        const segmentRecord = segment as Record<string, unknown>;
        const guardFindingsRaw: unknown[] = Array.isArray(
          segmentRecord.guardFindings,
        )
          ? (segmentRecord.guardFindings as unknown[])
          : Array.isArray(segmentRecord.guard_findings)
            ? (segmentRecord.guard_findings as unknown[])
            : [];

        const guardFindings: GuardFinding[] = guardFindingsRaw
          .map((finding): GuardFinding | null => {
            if (!isRecord(finding)) return null;
            const summary =
              typeof finding.summary === "string" ? finding.summary : null;
            if (!summary) return null;
            const normalized: GuardFinding = {
              type: typeof finding.type === "string" ? finding.type : "unknown",
              summary,
            };
            if (finding.ok !== undefined) {
              normalized.ok = Boolean(finding.ok);
            }
            if (typeof finding.severity === "string") {
              normalized.severity = finding.severity;
            }
            if (typeof finding.segmentId === "string") {
              normalized.segmentId = finding.segmentId;
            }
            if (isRecord(finding.details)) {
              normalized.details = finding.details;
            }
            return normalized;
          })
          .filter((value): value is GuardFinding => Boolean(value));

        const segmentIdSource = segmentRecord.segmentId ?? segmentRecord.segment_id;
        const segmentId =
          typeof segmentIdSource === "string" ? segmentIdSource : "";
        if (!segmentId) {
          return acc;
        }

        const guards = isRecord(segmentRecord.guards)
          ? (segmentRecord.guards as Record<string, unknown>)
          : null;

        acc.push({
          segmentIndex: Number(
            segmentRecord.segmentIndex ?? segmentRecord.segment_index ?? 0,
          ),
          segmentId,
          guards,
          guardFindings,
        });

        return acc;
      },
      [],
    );

    const completedStages = Array.isArray(job.sequential.completedStages)
      ? job.sequential.completedStages
          .map((stage) => (typeof stage === "string" ? stage : null))
          .filter((stage): stage is string => Boolean(stage))
      : [];

    const pipelineStages = Array.isArray(job.sequential.pipelineStages)
      ? job.sequential.pipelineStages
          .map((stage) => (typeof stage === "string" ? stage : null))
          .filter((stage): stage is string => Boolean(stage))
      : undefined;

    sequential = {
      stageCounts,
      totalSegments: Number(job.sequential.totalSegments ?? 0),
      needsReviewCount: Number(job.sequential.needsReviewCount ?? 0),
      completedStages,
      currentStage:
        typeof job.sequential.currentStage === "string"
          ? job.sequential.currentStage
          : null,
      guardFailures,
      flaggedSegments,
      pipelineStages,
    };
  }

  return {
    id: String(job.id ?? ""),
    document_id:
      typeof job.document_id === "string" ? job.document_id : undefined,
    project_id: typeof job.project_id === "string" ? job.project_id : undefined,
    type:
      job.type === "analyze" || job.type === "profile" ? job.type : "translate",
    status: typeof job.status === "string" ? job.status : "unknown",
    origin_lang:
      typeof job.origin_lang === "string" ? job.origin_lang : undefined,
    target_lang:
      typeof job.target_lang === "string" ? job.target_lang : undefined,
    created_at: typeof job.created_at === "string" ? job.created_at : undefined,
    updated_at: typeof job.updated_at === "string" ? job.updated_at : undefined,
    finished_at:
      typeof job.finished_at === "string" ? job.finished_at : undefined,
    last_error: typeof job.last_error === "string" ? job.last_error : undefined,
    batches,
    drafts,
    finalTranslation: finalTranslation ?? null,
    sequential,
  };
};

const toNumberOrNull = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const normalizeCoverAsset = (value: unknown): CoverAssetInfo | null => {
  if (!isRecord(value)) return null;

  const assetId = String(
    value.assetId ?? value.asset_id ?? value.ebook_asset_id ?? "",
  );
  if (!assetId) return null;

  const roleRaw =
    typeof value.role === "string"
      ? value.role
      : typeof value.asset_type === "string"
        ? value.asset_type.replace("cover-", "")
        : "wrap";
  const role = (
    ["front", "back", "spine", "wrap"] as CoverAssetRole[]
  ).includes(roleRaw as CoverAssetRole)
    ? (roleRaw as CoverAssetRole)
    : "wrap";

  return {
    assetId,
    role,
    publicUrl:
      typeof value.publicUrl === "string"
        ? value.publicUrl
        : typeof value.public_url === "string"
          ? value.public_url
          : "",
    fileName:
      typeof value.fileName === "string"
        ? value.fileName
        : typeof value.file_name === "string"
          ? value.file_name
          : "cover.jpg",
    filePath:
      typeof value.filePath === "string"
        ? value.filePath
        : typeof value.file_path === "string"
          ? value.file_path
          : "",
    mimeType:
      typeof value.mimeType === "string"
        ? value.mimeType
        : typeof value.mime_type === "string"
          ? value.mime_type
          : "image/jpeg",
    width: toNumberOrNull(value.width),
    height: toNumberOrNull(value.height),
    sizeBytes: toNumberOrNull(value.sizeBytes ?? value.size_bytes) ?? 0,
    checksum: typeof value.checksum === "string" ? value.checksum : "",
  };
};

const normalizeCoverResponse = (payload: unknown): CoverInfo => {
  if (!isRecord(payload)) {
    return {
      projectId: "",
      currentSetId: null,
      coverSets: [],
      fallbackUrl: null,
    };
  }

  const coverSetsRaw = Array.isArray(payload.coverSets)
    ? payload.coverSets
    : [];
  const coverSets = coverSetsRaw
    .map((entry) => {
      if (!isRecord(entry)) return null;
      const assetsRaw = Array.isArray(entry.assets) ? entry.assets : [];
      const assets = assetsRaw
        .map((asset) => normalizeCoverAsset(asset))
        .filter((asset): asset is CoverAssetInfo => Boolean(asset));

      return {
        coverSetId: String(entry.coverSetId ?? entry.cover_set_id ?? ""),
        status: (typeof entry.status === "string"
          ? entry.status
          : "queued") as CoverStatus,
        isCurrent: Boolean(entry.isCurrent ?? entry.is_current ?? false),
        generatedAt:
          typeof entry.generatedAt === "string"
            ? entry.generatedAt
            : typeof entry.generated_at === "string"
              ? entry.generated_at
              : new Date().toISOString(),
        createdBy:
          typeof entry.createdBy === "string"
            ? entry.createdBy
            : typeof entry.created_by === "string"
              ? entry.created_by
              : null,
        prompt: typeof entry.prompt === "string" ? entry.prompt : null,
        summary:
          typeof entry.summary === "string"
            ? entry.summary
            : typeof entry.summary_snapshot === "string"
              ? entry.summary_snapshot
              : null,
        failureReason:
          typeof entry.failureReason === "string"
            ? entry.failureReason
            : typeof entry.failure_reason === "string"
              ? entry.failure_reason
              : null,
        assets,
      } as CoverSetInfo;
    })
    .filter((set): set is CoverSetInfo => Boolean(set));

  const currentSetId =
    typeof payload.currentSetId === "string"
      ? payload.currentSetId
      : typeof payload.current_set_id === "string"
        ? payload.current_set_id
        : (coverSets.find((set) => set.isCurrent)?.coverSetId ?? null);

  return {
    projectId: String(payload.projectId ?? ""),
    currentSetId,
    coverSets,
    fallbackUrl:
      typeof payload.fallbackUrl === "string" ? payload.fallbackUrl : null,
  };
};

const normalizeEbookDetails = (payload: unknown): EbookDetails => {
  if (!isRecord(payload)) {
    return {
      projectId: "",
      status: "missing",
      ebook: null,
      metadata: { writerNote: null, translatorNote: null, isbn: null },
      latestVersion: null,
      distribution: [],
    };
  }

  const ebook = isRecord(payload.ebook)
    ? {
        ebookId: String(payload.ebook.ebookId ?? payload.ebook.ebook_id ?? ""),
        title:
          typeof payload.ebook.title === "string" ? payload.ebook.title : null,
        author:
          typeof payload.ebook.author === "string"
            ? payload.ebook.author
            : null,
        translator:
          typeof payload.ebook.translator === "string"
            ? payload.ebook.translator
            : null,
        synopsis:
          typeof payload.ebook.synopsis === "string"
            ? payload.ebook.synopsis
            : null,
        sourceLanguage:
          typeof payload.ebook.sourceLanguage === "string"
            ? payload.ebook.sourceLanguage
            : typeof payload.ebook.source_language === "string"
              ? payload.ebook.source_language
              : null,
        targetLanguage:
          typeof payload.ebook.targetLanguage === "string"
            ? payload.ebook.targetLanguage
            : typeof payload.ebook.target_language === "string"
              ? payload.ebook.target_language
              : null,
        createdAt:
          typeof payload.ebook.createdAt === "string"
            ? payload.ebook.createdAt
            : typeof payload.ebook.created_at === "string"
              ? payload.ebook.created_at
              : null,
        updatedAt:
          typeof payload.ebook.updatedAt === "string"
            ? payload.ebook.updatedAt
            : typeof payload.ebook.updated_at === "string"
              ? payload.ebook.updated_at
              : null,
        currentVersionId:
          typeof payload.ebook.currentVersionId === "string"
            ? payload.ebook.currentVersionId
            : typeof payload.ebook.current_version_id === "string"
              ? payload.ebook.current_version_id
              : null,
      }
    : null;

  const metaRecord = isRecord(payload.metadata) ? payload.metadata : {};
  const metadata = {
    writerNote:
      typeof metaRecord.writerNote === "string"
        ? metaRecord.writerNote
        : typeof metaRecord.writer_note === "string"
          ? metaRecord.writer_note
          : null,
    translatorNote:
      typeof metaRecord.translatorNote === "string"
        ? metaRecord.translatorNote
        : typeof metaRecord.translator_note === "string"
          ? metaRecord.translator_note
          : null,
    isbn: typeof metaRecord.isbn === "string" ? metaRecord.isbn : null,
  };

  const versionRecord = isRecord(payload.latestVersion)
    ? payload.latestVersion
    : {};
  const assetRecord = isRecord(versionRecord.asset) ? versionRecord.asset : {};

  const asset =
    versionRecord && isRecord(versionRecord.asset)
      ? {
          assetId: String(
            assetRecord.assetId ??
              assetRecord.asset_id ??
              assetRecord.ebook_asset_id ??
              "",
          ),
          fileName:
            typeof assetRecord.fileName === "string"
              ? assetRecord.fileName
              : typeof assetRecord.file_name === "string"
                ? assetRecord.file_name
                : "ebook",
          publicUrl:
            typeof assetRecord.publicUrl === "string"
              ? assetRecord.publicUrl
              : typeof assetRecord.public_url === "string"
                ? assetRecord.public_url
                : "",
          mimeType:
            typeof assetRecord.mimeType === "string"
              ? assetRecord.mimeType
              : typeof assetRecord.mime_type === "string"
                ? assetRecord.mime_type
                : "application/octet-stream",
          filePath:
            typeof assetRecord.filePath === "string"
              ? assetRecord.filePath
              : typeof assetRecord.file_path === "string"
                ? assetRecord.file_path
                : "",
          sizeBytes:
            toNumberOrNull(assetRecord.sizeBytes ?? assetRecord.size_bytes) ??
            0,
          checksum:
            typeof assetRecord.checksum === "string"
              ? assetRecord.checksum
              : "",
        }
      : null;

  const latestVersion =
    versionRecord && versionRecord.ebook_version_id
      ? {
          ebookVersionId: String(
            versionRecord.ebookVersionId ??
              versionRecord.ebook_version_id ??
              "",
          ),
          versionNumber: Number(
            versionRecord.versionNumber ?? versionRecord.version_number ?? 1,
          ),
          translationFileId:
            typeof versionRecord.translationFileId === "string"
              ? versionRecord.translationFileId
              : typeof versionRecord.translation_file_id === "string"
                ? versionRecord.translation_file_id
                : null,
          qualityAssessmentId:
            typeof versionRecord.qualityAssessmentId === "string"
              ? versionRecord.qualityAssessmentId
              : typeof versionRecord.quality_assessment_id === "string"
                ? versionRecord.quality_assessment_id
                : null,
          format:
            typeof versionRecord.format === "string"
              ? versionRecord.format
              : typeof versionRecord.export_format === "string"
                ? versionRecord.export_format
                : "txt",
          wordCount: toNumberOrNull(
            versionRecord.wordCount ?? versionRecord.word_count,
          ),
          characterCount: toNumberOrNull(
            versionRecord.characterCount ?? versionRecord.character_count,
          ),
          createdAt:
            typeof versionRecord.createdAt === "string"
              ? versionRecord.createdAt
              : typeof versionRecord.created_at === "string"
                ? versionRecord.created_at
                : null,
          createdBy:
            typeof versionRecord.createdBy === "string"
              ? versionRecord.createdBy
              : typeof versionRecord.created_by === "string"
                ? versionRecord.created_by
                : null,
          asset,
        }
      : null;

  const distributionRaw = Array.isArray(payload.distribution)
    ? payload.distribution
    : [];
  const distribution = distributionRaw.map((entry) => {
    const record = isRecord(entry) ? entry : {};
    return {
      channel: typeof record.channel === "string" ? record.channel : "unknown",
      status: typeof record.status === "string" ? record.status : "pending",
      listingId:
        typeof record.listingId === "string"
          ? record.listingId
          : typeof record.listing_id === "string"
            ? record.listing_id
            : null,
      price: toNumberOrNull(record.price),
      currency: typeof record.currency === "string" ? record.currency : null,
      plannedPublishAt:
        typeof record.plannedPublishAt === "string"
          ? record.plannedPublishAt
          : typeof record.planned_publish_at === "string"
            ? record.planned_publish_at
            : null,
      publishedAt:
        typeof record.publishedAt === "string"
          ? record.publishedAt
          : typeof record.published_at === "string"
            ? record.published_at
            : null,
      lastSyncedAt:
        typeof record.lastSyncedAt === "string"
          ? record.lastSyncedAt
          : typeof record.last_synced_at === "string"
            ? record.last_synced_at
            : null,
      failureReason:
        typeof record.failureReason === "string"
          ? record.failureReason
          : typeof record.failure_reason === "string"
            ? record.failure_reason
            : null,
    } as EbookDistributionInfo;
  });

  return {
    projectId: String(payload.projectId ?? ""),
    status: typeof payload.status === "string" ? payload.status : "missing",
    ebook,
    metadata,
    latestVersion,
    distribution,
  };
};

export const api = {
  async me(token: string): Promise<UserProfile> {
    const res = await fetch(`${API_BASE}/api/auth/me`, {
      headers: defaultHeaders(token),
    });
    return handle<UserProfile>(res);
  },

  async listProjects(token: string) {
    const res = await fetch(`${API_BASE}/api/projects`, {
      headers: defaultHeaders(token),
    });
    const data = await handle<{ projects: ProjectSummary[] | undefined }>(res);
    return data.projects ?? [];
  },

  async createProject(
    token: string,
    payload: {
      title: string;
      origin_lang?: string;
      target_lang?: string;
      description?: string;
      intention?: string;
      translator_name?: string;
    },
  ): Promise<{ project: ProjectSummary }> {
    const res = await fetch(`${API_BASE}/api/projects`, {
      method: "POST",
      headers: defaultHeaders(token),
      body: JSON.stringify(payload),
    });
    return handle(res);
  },

  async recommendOrCreateEbook(
    token: string,
    payload: {
      projectId: string;
      translationFileId?: string | null;
      format?: string;
    },
  ): Promise<EbookResponse> {
    const res = await fetch(`${API_BASE}/api/ebook/generate`, {
      method: "POST",
      headers: defaultHeaders(token),
      body: JSON.stringify(payload),
    });
    return handle<EbookResponse>(res);
  },

  async fetchProofreadingLogs(
    token: string,
    params: { projectId?: string; limit?: number } = {},
  ): Promise<ProofreadingLogEntry[]> {
    const search = new URLSearchParams();
    if (params.projectId) {
      search.set("projectId", params.projectId);
    }
    if (params.limit) {
      search.set("limit", String(params.limit));
    }

    const res = await fetch(
      `${API_BASE}/api/admin/proofreading/logs${
        search.toString() ? `?${search.toString()}` : ""
      }`,
      {
        headers: defaultHeaders(token),
      },
    );

    type RawEntry = {
      id: string;
      project_id: string;
      job_id: string;
      proofreading_id: string;
      run_id: string;
      tier: string;
      subfeature_key: string;
      subfeature_label: string;
      chunk_index: number;
      model: string;
      max_output_tokens: number;
      attempts: number;
      truncated: boolean;
      request_id: string | null;
      guard_segments: number;
      memory_version: number | null;
      usage_prompt_tokens: number | null;
      usage_completion_tokens: number | null;
      usage_total_tokens: number | null;
      verbosity: string;
      reasoning_effort: string;
      created_at: string;
      downshift_attempts?: number | null;
      forced_pagination?: number | null;
      cursor_retry?: number | null;
    };

    const data = await handle<{ logs?: RawEntry[] }>(res);
    const rows = Array.isArray(data.logs) ? data.logs : [];

    return rows.map((entry) => ({
      id: String(entry.id ?? ""),
      projectId: String(entry.project_id ?? ""),
      jobId: String(entry.job_id ?? ""),
      proofreadingId: String(entry.proofreading_id ?? ""),
      runId: String(entry.run_id ?? ""),
      tier:
        entry.tier === "deep"
          ? "deep"
          : entry.tier === "quick"
            ? "quick"
            : "quick",
      subfeatureKey: String(entry.subfeature_key ?? ""),
      subfeatureLabel: String(entry.subfeature_label ?? ""),
      chunkIndex: Number(entry.chunk_index ?? 0),
      model: String(entry.model ?? ""),
      maxOutputTokens: Number(entry.max_output_tokens ?? 0),
      attempts: Number(entry.attempts ?? 0),
      truncated: Boolean(entry.truncated),
      requestId: entry.request_id ?? null,
      guardSegments: Number(entry.guard_segments ?? 0),
      memoryVersion:
        entry.memory_version === null || entry.memory_version === undefined
          ? null
          : Number(entry.memory_version),
      usagePromptTokens:
        entry.usage_prompt_tokens === null ||
        entry.usage_prompt_tokens === undefined
          ? null
          : Number(entry.usage_prompt_tokens),
      usageCompletionTokens:
        entry.usage_completion_tokens === null ||
        entry.usage_completion_tokens === undefined
          ? null
          : Number(entry.usage_completion_tokens),
      usageTotalTokens:
        entry.usage_total_tokens === null ||
        entry.usage_total_tokens === undefined
          ? null
          : Number(entry.usage_total_tokens),
      verbosity: String(entry.verbosity ?? ""),
      reasoningEffort: String(entry.reasoning_effort ?? ""),
      createdAt: String(entry.created_at ?? ""),
      downshiftAttempts: Number(entry.downshift_attempts ?? 0),
      forcedPagination: Number(entry.forced_pagination ?? 0),
      cursorRetry: Number(entry.cursor_retry ?? 0),
    }));
  },

  async fetchTranslationDraftRuns(
    token: string,
    params: { projectId?: string; limit?: number } = {},
  ): Promise<TranslationDraftAdminRun[]> {
    const search = new URLSearchParams();
    if (params.projectId) {
      search.set("projectId", params.projectId);
    }
    if (params.limit) {
      search.set("limit", String(params.limit));
    }

    const res = await fetch(
      `${API_BASE}/api/admin/translation/drafts${
        search.toString() ? `?${search.toString()}` : ""
      }`,
      {
        headers: defaultHeaders(token),
      },
    );

    type RawDraft = {
      id?: string;
      projectId?: string;
      jobId?: string;
      runOrder?: number;
      model?: string | null;
      verbosity?: string | null;
      reasoningEffort?: string | null;
      maxOutputTokens?: number | null;
      retryCount?: number | null;
      attempts?: number | null;
      truncated?: boolean;
      fallbackModelUsed?: boolean;
      usage?: {
        inputTokens?: number | null;
        outputTokens?: number | null;
      };
      finishedAt?: string | null;
      updatedAt?: string;
    };

    const data = await handle<{ drafts?: RawDraft[] }>(res);
    const rows = Array.isArray(data.drafts) ? data.drafts : [];

    return rows.map((entry) => ({
      id: String(entry.id ?? ""),
      projectId: String(entry.projectId ?? ""),
      jobId: String(entry.jobId ?? ""),
      runOrder: Number(entry.runOrder ?? 0),
      model: entry.model ?? null,
      verbosity: entry.verbosity ?? null,
      reasoningEffort: entry.reasoningEffort ?? null,
      maxOutputTokens:
        entry.maxOutputTokens === null || entry.maxOutputTokens === undefined
          ? null
          : Number(entry.maxOutputTokens),
      retryCount: Number(entry.retryCount ?? 0),
      attempts:
        entry.attempts === null || entry.attempts === undefined
          ? null
          : Number(entry.attempts),
      truncated: Boolean(entry.truncated),
      fallbackModelUsed: Boolean(entry.fallbackModelUsed),
      usageInputTokens:
        entry.usage?.inputTokens === null ||
        entry.usage?.inputTokens === undefined
          ? null
          : Number(entry.usage.inputTokens),
      usageOutputTokens:
        entry.usage?.outputTokens === null ||
        entry.usage?.outputTokens === undefined
          ? null
          : Number(entry.usage.outputTokens),
      finishedAt: entry.finishedAt ?? null,
      updatedAt: String(entry.updatedAt ?? ""),
    }));
  },

  async fetchProjectTranslations(
    token: string,
    projectId: string,
  ): Promise<ProjectTranslationOption[]> {
    const res = await fetch(
      `${API_BASE}/api/projects/${projectId}/translations`,
      {
        headers: defaultHeaders(token),
      },
    );
    const data = await handle<unknown>(res);
    if (!Array.isArray(data)) return [];
    return data
      .filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null,
      )
      .map((entry) => ({
        translationFileId: String(
          entry.translationFileId ?? entry.translation_file_id ?? "",
        ),
        filename: typeof entry.filename === "string" ? entry.filename : null,
        jobId:
          typeof entry.jobId === "string"
            ? entry.jobId
            : typeof entry.job_id === "string"
              ? entry.job_id
              : null,
        createdAt:
          typeof entry.createdAt === "string"
            ? entry.createdAt
            : typeof entry.created_at === "string"
              ? entry.created_at
              : null,
        updatedAt:
          typeof entry.updatedAt === "string"
            ? entry.updatedAt
            : typeof entry.updated_at === "string"
              ? entry.updated_at
              : null,
        completedAt:
          typeof entry.completedAt === "string"
            ? entry.completedAt
            : typeof entry.completed_at === "string"
              ? entry.completed_at
              : null,
        qualityScore: toNumberOrNull(entry.qualityScore ?? entry.quality_score),
        qualityAssessmentId:
          typeof entry.qualityAssessmentId === "string"
            ? entry.qualityAssessmentId
            : typeof entry.quality_assessment_id === "string"
              ? entry.quality_assessment_id
              : null,
      }))
      .filter((item) => Boolean(item.translationFileId));
  },

  async fetchCover(token: string, projectId: string): Promise<CoverInfo> {
    const res = await fetch(`${API_BASE}/api/projects/${projectId}/cover`, {
      headers: defaultHeaders(token),
    });
    const data = await handle<unknown>(res);
    return normalizeCoverResponse(data);
  },

  async regenerateCover(
    token: string,
    projectId: string,
  ): Promise<{ coverSetId: string; status: CoverStatus }> {
    const res = await fetch(
      `${API_BASE}/api/projects/${projectId}/cover/regenerate`,
      {
        method: "POST",
        headers: defaultHeaders(token),
        body: JSON.stringify({}),
      },
    );
    const data = await handle<unknown>(res);
    if (!isRecord(data)) {
      return { coverSetId: "", status: "queued" };
    }
    const coverSetId =
      typeof data.coverSetId === "string"
        ? data.coverSetId
        : typeof data.cover_set_id === "string"
          ? data.cover_set_id
          : "";
    const statusRaw = typeof data.status === "string" ? data.status : "queued";
    const status: CoverStatus = (
      ["queued", "generating", "ready", "failed"] as CoverStatus[]
    ).includes(statusRaw as CoverStatus)
      ? (statusRaw as CoverStatus)
      : "queued";
    return { coverSetId, status };
  },

  async fetchCoverImage(
    token: string,
    projectId: string,
    assetId: string,
  ): Promise<Blob> {
    const res = await fetch(
      `${API_BASE}/api/projects/${projectId}/cover/image/${assetId}`,
      {
        headers: defaultHeaders(token),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || res.statusText);
    }
    return res.blob();
  },

  async downloadEbook(
    token: string,
    projectId: string,
    assetId: string,
  ): Promise<Blob> {
    const headers: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {};
    const res = await fetch(
      `${API_BASE}/api/projects/${projectId}/ebook/download/${assetId}`,
      {
        headers,
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || res.statusText);
    }
    return res.blob();
  },

  async fetchEbookDetails(
    token: string,
    projectId: string,
  ): Promise<EbookDetails> {
    const res = await fetch(`${API_BASE}/api/projects/${projectId}/ebook`, {
      headers: defaultHeaders(token),
    });
    const data = await handle<unknown>(res);
    return normalizeEbookDetails(data);
  },

  async usage(token: string, projectId: string): Promise<ProjectUsageResponse> {
    const res = await fetch(`${API_BASE}/api/usage/${projectId}`, {
      headers: defaultHeaders(token),
    });
    return handle<ProjectUsageResponse>(res);
  },

  async projectContent(
    token: string,
    projectId: string,
  ): Promise<ProjectContent> {
    const res = await fetch(
      `${API_BASE}/api/project/${projectId}/latestContent`,
      {
        headers: defaultHeaders(token),
      },
    );
    return handleWrapped<ProjectContent>(res);
  },

  async retryOriginAnalysis(token: string, projectId: string) {
    const res = await fetch(
      `${API_BASE}/api/projects/${projectId}/origin/reanalyze`,
      {
        method: "POST",
        headers: defaultHeaders(token),
      },
    );
    return handle<{ jobId: string }>(res);
  },

  async workflowSummary(
    token: string,
    projectId: string,
  ): Promise<WorkflowSummary> {
    const res = await fetch(`${API_BASE}/api/projects/${projectId}/workflow`, {
      headers: defaultHeaders(token),
    });
    return handle<WorkflowSummary>(res);
  },

  async requestWorkflowAction(
    token: string,
    projectId: string,
    payload: {
      type: WorkflowRunRecord["type"];
      label?: string | null;
      intentText?: string | null;
      metadata?: Record<string, unknown> | null;
      parentRunId?: string | null;
    },
  ) {
    const res = await fetch(
      `${API_BASE}/api/projects/${projectId}/workflow/actions`,
      {
        method: "POST",
        headers: defaultHeaders(token),
        body: JSON.stringify(payload),
      },
    );
    return handle<{
      accepted: boolean;
      reason?: string;
      projectStatus?: string | null;
      run?: WorkflowRunRecord;
    }>(res);
  },

  async updateWorkflowStatus(
    token: string,
    projectId: string,
    runId: string,
    payload: {
      status: "succeeded" | "failed" | "cancelled";
      metadata?: Record<string, unknown> | null;
    },
  ) {
    const res = await fetch(
      `${API_BASE}/api/projects/${projectId}/workflow/${runId}/status`,
      {
        method: "POST",
        headers: defaultHeaders(token),
        body: JSON.stringify(payload),
      },
    );
    return handle<{ run: WorkflowRunRecord }>(res);
  },

  async cancelWorkflowRuns(token: string, projectId: string, reason?: string) {
    const res = await fetch(
      `${API_BASE}/api/projects/${projectId}/workflow/cancel-all`,
      {
        method: "POST",
        headers: defaultHeaders(token),
        body: JSON.stringify({ reason: reason ?? null }),
      },
    );
    return handle<{ ok: boolean }>(res);
  },

  async updateProject(
    token: string,
    projectId: string,
    payload: {
      title?: string;
      book_title?: string;
      author_name?: string | null;
      translator_name?: string | null;
      description?: string;
      intention?: string;
      memo?: string;
      status?: string;
      origin_lang?: string;
      target_lang?: string;
      meta?: Record<string, unknown>;
      user_consent?: Record<string, unknown> | null;
    },
  ) {
    const res = await fetch(`${API_BASE}/api/projects/${projectId}`, {
      method: "PUT",
      headers: defaultHeaders(token),
      body: JSON.stringify(payload),
    });
    return handle(res);
  },

  async userPreferences(token: string): Promise<{
    preferred_language: string | null;
  }> {
    const res = await fetch(`${API_BASE}/api/user/preferences`, {
      headers: defaultHeaders(token),
    });
    return handle<{ preferred_language: string | null }>(res);
  },

  async updateUserPreferences(
    token: string,
    payload: { preferred_language: string | null },
  ): Promise<{ ok: boolean; preferred_language: string | null }> {
    const res = await fetch(`${API_BASE}/api/user/preferences`, {
      method: "PUT",
      headers: defaultHeaders(token),
      body: JSON.stringify(payload),
    });
    return handle<{ ok: boolean; preferred_language: string | null }>(res);
  },

  async qualityHistory(
    token: string,
    projectId: string,
  ): Promise<QualityHistoryResponse> {
    const res = await fetch(`${API_BASE}/api/quality/${projectId}/history`, {
      headers: defaultHeaders(token),
    });
    return handle<QualityHistoryResponse>(res);
  },

  async startTranslation(
    token: string,
    payload: {
      documentId: string;
      originDocumentId?: string | null;
      originalText?: string;
      targetLang?: string;
      project_id: string;
      created_by?: string;
      updated_at?: string;
      updated_by?: string;
      workflowLabel?: string | null;
      workflowAllowParallel?: boolean;
    },
  ) {
    const res = await fetch(`${API_BASE}/api/pipeline/translate`, {
      method: "POST",
      headers: defaultHeaders(token),
      body: JSON.stringify(payload),
    });
    return handle<{
      jobId: string;
      workflowRunId?: string | null;
      totalPasses: number;
      segmentCount: number;
      segmentationMode?: string;
      sourceHash?: string;
      pipeline?: string;
    }>(res);
  },

  streamTranslation(config: {
    token: string | null;
    projectId: string;
    jobId: string;
    onEvent?: (event: TranslationStreamEvent) => void;
    onError?: (error: Error) => void;
  }): () => void {
    const { token, projectId, jobId, onEvent, onError } = config;
    const controller = new AbortController();
    const search = new URLSearchParams({ jobId });
    const url = `${API_BASE}/api/projects/${projectId}/translations/stream?${search.toString()}`;
    const headers: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {};

    fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || "Failed to subscribe to translation stream");
        }
        try {
          await streamNdjson<TranslationStreamEvent>(
            res,
            (event) => {
              if (event) onEvent?.(event);
            },
            (error, payload) => {
              console.warn(
                "[api] failed to parse translation stream event",
                {
                  error,
                  payload,
                },
              );
            },
          );
        } catch (error) {
          if (!controller.signal.aborted) {
            throw error;
          }
        }
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        onError?.(err instanceof Error ? err : new Error(String(err)));
      });

    return () => {
      controller.abort();
    };
  },

  subscribeProofreadStream(config: {
    token: string | null;
    projectId: string;
    runId?: string | null;
    proofreadingId?: string | null;
    onEvent?: (event: ProofreadStreamEvent) => void;
    onError?: (error: Error) => void;
  }): () => void {
    const { token, projectId, runId, proofreadingId, onEvent, onError } = config;
    const controller = new AbortController();
    const search = new URLSearchParams();
    if (runId) search.set("runId", runId);
    if (proofreadingId) search.set("proofreadingId", proofreadingId);
    const query = search.toString();
    const url = `${API_BASE}/api/projects/${projectId}/proofread/stream${
      query ? `?${query}` : ""
    }`;

    if (!search.has("runId") && !search.has("proofreadingId")) {
      throw new Error("runId or proofreadingId is required to subscribe proofread stream");
    }

    const headers: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {};

    fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || "Failed to subscribe to proofread stream");
        }
        try {
          await streamNdjson<ProofreadStreamEvent>(
            res,
            (event) => {
              if (event) onEvent?.(event);
            },
            (error, payload) => {
              console.warn(
                "[api] failed to parse proofread stream event",
                {
                  error,
                  payload,
                },
              );
            },
          );
        } catch (error) {
          if (!controller.signal.aborted) {
            throw error;
          }
        }
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        onError?.(err instanceof Error ? err : new Error(String(err)));
      });

    return () => {
      controller.abort();
    };
  },

  async listJobs(
    token: string,
    options: { projectId?: string; status?: string; limit?: number } = {},
  ): Promise<JobSummary[]> {
    const params = new URLSearchParams();
    if (options.projectId) params.set("projectId", options.projectId);
    if (options.status) params.set("status", options.status);
    if (options.limit !== undefined) {
      params.set("limit", String(options.limit));
    }

    const search = params.toString();
    const url = search
      ? `${API_BASE}/api/jobs?${search}`
      : `${API_BASE}/api/jobs`;

    const res = await fetch(url, {
      headers: defaultHeaders(token),
    });
    const data = await handle<{ jobs?: unknown[] }>(res);
    return (data.jobs ?? []).map(normalizeJob);
  },

  async getJob(token: string, jobId: string): Promise<JobSummary | null> {
    const res = await fetch(`${API_BASE}/api/jobs/${jobId}`, {
      headers: defaultHeaders(token),
    });

    if (res.status === 404) {
      return null;
    }

    const data = await handle<{ job?: unknown }>(res);
    return data.job ? normalizeJob(data.job) : null;
  },

  async saveOrigin(
    token: string,
    projectId: string,
    payload: { content: string; filename?: string },
  ) {
    const res = await fetch(`${API_BASE}/api/projects/${projectId}/origin`, {
      method: "PUT",
      headers: defaultHeaders(token),
      body: JSON.stringify(payload),
    });
    return handle(res);
  },

  async uploadOriginFile(
    token: string,
    projectId: string,
    file: File,
    options?: { jobId?: string },
  ) {
    const formData = new FormData();
    formData.append("file", file);
    if (options?.jobId) {
      formData.append("jobId", options.jobId);
    }

    const request: RequestInit = {
      method: "PUT",
      body: formData,
    };

    if (token) {
      request.headers = { Authorization: `Bearer ${token}` };
    }

    const res = await fetch(
      `${API_BASE}/api/projects/${projectId}/origin`,
      request,
    );
    return handle<UploadOriginResponse>(res);
  },

  async saveTranslation(
    token: string,
    projectId: string,
    payload: { content: string; jobId?: string | null },
  ) {
    const res = await fetch(
      `${API_BASE}/api/projects/${projectId}/translation`,
      {
        method: "PUT",
        headers: defaultHeaders(token),
        body: JSON.stringify({
          content: payload.content,
          jobId: payload.jobId ?? undefined,
        }),
      },
    );
    return handle(res);
  },

  async updateTranslationNotes(
    token: string,
    projectId: string,
    payload: {
      translationNotes: DocumentProfileSummary["translationNotes"] | null;
    },
  ) {
    const res = await fetch(
      `${API_BASE}/api/project/${projectId}/profiles/origin/translation-notes`,
      {
        method: "PUT",
        headers: defaultHeaders(token),
        body: JSON.stringify({ translationNotes: payload.translationNotes }),
      },
    );
    return handle(res);
  },

  async rewriteSelection(
    token: string,
    projectId: string,
    payload: {
      selection: EditingSelectionPayload;
      prompt: string;
      locale?: string | null;
      context?: Record<string, unknown> | null;
    },
  ): Promise<EditingSuggestionResponse> {
    const res = await fetch(
      `${API_BASE}/api/projects/${projectId}/editing/rewrite`,
      {
        method: "POST",
        headers: defaultHeaders(token),
        body: JSON.stringify({
          selection: payload.selection,
          prompt: payload.prompt,
          locale: payload.locale ?? null,
          context: payload.context ?? null,
        }),
      },
    );
    return handle<EditingSuggestionResponse>(res);
  },

  async normalizeNameSelection(
    token: string,
    projectId: string,
    payload: {
      selection: EditingSelectionPayload;
      prompt: string;
      locale?: string | null;
      context?: Record<string, unknown> | null;
    },
  ): Promise<EditingSuggestionResponse> {
    const res = await fetch(
      `${API_BASE}/api/projects/${projectId}/editing/normalize-name`,
      {
        method: "POST",
        headers: defaultHeaders(token),
        body: JSON.stringify({
          selection: payload.selection,
          prompt: payload.prompt,
          locale: payload.locale ?? null,
          context: payload.context ?? null,
        }),
      },
    );
    return handle<EditingSuggestionResponse>(res);
  },

  async adjustPronounSelection(
    token: string,
    projectId: string,
    payload: {
      selection: EditingSelectionPayload;
      prompt: string;
      locale?: string | null;
      context?: Record<string, unknown> | null;
    },
  ): Promise<EditingSuggestionResponse> {
    const res = await fetch(
      `${API_BASE}/api/projects/${projectId}/editing/adjust-pronoun`,
      {
        method: "POST",
        headers: defaultHeaders(token),
        body: JSON.stringify({
          selection: payload.selection,
          prompt: payload.prompt,
          locale: payload.locale ?? null,
          context: payload.context ?? null,
        }),
      },
    );
    return handle<EditingSuggestionResponse>(res);
  },

  async cancelTranslation(
    token: string,
    projectId: string,
    payload: {
      jobId?: string | null;
      workflowRunId?: string | null;
      reason?: string | null;
    },
  ) {
    const res = await fetch(
      `${API_BASE}/api/projects/${projectId}/translation/cancel`,
      {
        method: "POST",
        headers: defaultHeaders(token),
        body: JSON.stringify({
          jobId: payload.jobId ?? null,
          workflowRunId: payload.workflowRunId ?? null,
          reason: payload.reason ?? null,
        }),
      },
    );
    return handle(res);
  },

  async chat(
    token: string,
    payload: {
      projectId: string | null;
      messages: ChatMessagePayload[];
      contextSnapshot?: ProjectContextSnapshotPayload | null;
      model?: string | null;
    },
  ): Promise<ChatResponse> {
    const res = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: defaultHeaders(token),
      body: JSON.stringify(payload),
    });
    const data = await handle<{
      reply?: string;
      actions?: ChatAction[];
      profileUpdates?: Record<string, unknown>;
      model?: string;
    }>(res);
    return {
      reply: data.reply ?? "요청을 처리했습니다.",
      actions: data.actions ?? [{ type: "acknowledge" }],
      profileUpdates: data.profileUpdates,
      model: data.model,
    };
  },

  async chatStream(
    token: string,
    payload: {
      projectId: string | null;
      messages: ChatMessagePayload[];
      contextSnapshot?: ProjectContextSnapshotPayload | null;
      model?: string | null;
    },
    handlers: {
      onDelta?: (delta: string) => void;
      onComplete?: (event: ChatStreamCompleteEvent) => void;
      onError?: (message: string) => void;
      signal?: AbortSignal;
    } = {},
  ): Promise<void> {
    const controller = new AbortController();
    if (handlers.signal) {
      const abortViaSignal = () => controller.abort();
      if (handlers.signal.aborted) {
        controller.abort();
      } else {
        handlers.signal.addEventListener("abort", abortViaSignal, {
          once: true,
        });
      }
    }

    const res = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: defaultHeaders(token),
      body: JSON.stringify({ ...payload, stream: true }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || "Failed to stream chat");
    }

    const body = res.body;
    if (!body) {
      throw new Error("Streaming body is not supported in this environment");
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let completed = false;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.startsWith(":")) continue;
          if (!trimmed.startsWith("data:")) continue;
          const payloadText = trimmed.slice(5).trim();
          if (!payloadText) continue;
          try {
            const event = JSON.parse(payloadText) as ChatStreamEvent;
            switch (event.type) {
              case "chat.delta": {
                if (typeof event.text === "string") {
                  handlers.onDelta?.(event.text);
                }
                break;
              }
              case "chat.complete": {
                completed = true;
                handlers.onComplete?.(event);
                break;
              }
              case "chat.error": {
                const message =
                  typeof event.message === "string"
                    ? event.message
                    : "Chat stream error";
                handlers.onError?.(message);
                throw new Error(message);
              }
              case "chat.end":
                break;
              default:
                break;
            }
          } catch (err) {
            console.warn("[api] failed to parse chat stream event", err);
          }
        }
      }
    } finally {
      controller.abort();
    }

    if (!completed) {
      throw new Error("Chat stream ended without completion event");
    }
  },

  async listModels(token: string): Promise<ModelListResponse> {
    const res = await fetch(`${API_BASE}/api/models`, {
      headers: defaultHeaders(token),
    });
    return handle<ModelListResponse>(res);
  },

  async chatHistory(
    token: string,
    projectId: string,
  ): Promise<ChatHistoryItem[]> {
    const res = await fetch(`${API_BASE}/api/chat/history/${projectId}`, {
      headers: defaultHeaders(token),
    });
    const data = await handle<{ messages?: ChatHistoryItem[] }>(res);
    return data.messages ?? [];
  },

  async chatLog(token: string, payload: ChatLogRequest) {
    const res = await fetch(`${API_BASE}/api/chat/log`, {
      method: "POST",
      headers: defaultHeaders(token),
      body: JSON.stringify(payload),
    });
    return handle(res);
  },

  async requestProofreading(
    token: string,
    projectId: string,
    jobId: string,
    config?: {
      onEvent?: (event: Record<string, unknown>) => void;
      label?: string | null;
      allowParallel?: boolean;
      runDeep?: boolean;
    },
  ) {
    const { onEvent, label, allowParallel, runDeep } = config ?? {};
    const res = await fetch(`${API_BASE}/api/proofread`, {
      method: "POST",
      headers: defaultHeaders(token),
      body: JSON.stringify({
        project_id: projectId,
        job_id: jobId,
        workflowLabel: label ?? null,
        workflowAllowParallel: allowParallel ?? false,
        includeDeep: Boolean(runDeep),
      }),
    });
    if (!res.ok) {
      throw new Error(await res.text());
    }
    if (!res.body) return;

    await streamNdjson<Record<string, unknown>>(
      res,
      (event) => {
        onEvent?.(event);
      },
      (error, payload) => {
        console.warn("[api] failed to parse proofreading event", {
          error,
          payload,
        });
      },
    );
  },

  async applyProofreading(
    token: string,
    proofreadingId: string,
    payload: { appliedIssueIds: string[]; translatedContent: string },
  ) {
    const res = await fetch(
      `${API_BASE}/api/proofread/${proofreadingId}/apply`,
      {
        method: "PATCH",
        headers: defaultHeaders(token),
        body: JSON.stringify({
          appliedIssueIds: payload.appliedIssueIds,
          translatedContent: payload.translatedContent,
        }),
      },
    );
    return handle(res);
  },

  async fetchProofreadEditorDataset(config: {
    token: string;
    projectId: string;
    jobId?: string | null;
    translationFileId?: string | null;
  }): Promise<ProofreadEditorResponse> {
    const { token, projectId, jobId = null, translationFileId = null } = config;
    const search = new URLSearchParams();
    if (jobId) search.set("jobId", jobId);
    if (translationFileId) search.set("translationFileId", translationFileId);
    const query = search.toString();
    const url = `${API_BASE}/api/projects/${projectId}/proofread/editor${
      query ? `?${query}` : ""
    }`;
    const res = await fetch(url, {
      method: "GET",
      headers: defaultHeaders(token),
    });
    return handle<ProofreadEditorResponse>(res);
  },

  async fetchProofreadItems(config: {
    token: string;
    projectId: string;
    runId: string;
    cursor: string;
    limit?: number;
  }): Promise<ProofreadItemsFetchResponse> {
    const { token, projectId, runId, cursor, limit } = config;
    const search = new URLSearchParams();
    if (cursor) search.set("cursor", cursor);
    if (typeof limit === "number" && Number.isFinite(limit)) {
      search.set("limit", String(limit));
    }
    const query = search.toString();
    const url = `${API_BASE}/api/projects/${projectId}/proofread/${runId}/items${
      query ? `?${query}` : ""
    }`;
    const res = await fetch(url, {
      method: "GET",
      headers: defaultHeaders(token),
    });
    return handle<ProofreadItemsFetchResponse>(res);
  },

  async fetchTranslationItems(config: {
    token: string;
    projectId: string;
    runId: string;
    cursor: string;
    limit?: number;
  }): Promise<TranslationItemsFetchResponse> {
    const { token, projectId, runId, cursor, limit } = config;
    const search = new URLSearchParams();
    if (cursor) search.set("cursor", cursor);
    if (typeof limit === "number" && Number.isFinite(limit)) {
      search.set("limit", String(limit));
    }
    const query = search.toString();
    const url = `${API_BASE}/api/projects/${projectId}/translations/${runId}/items${
      query ? `?${query}` : ""
    }`;
    const res = await fetch(url, {
      method: "GET",
      headers: defaultHeaders(token),
    });
    return handle<TranslationItemsFetchResponse>(res);
  },

  async warmupCanonicalCache(config: {
    token: string;
    projectId: string;
    jobId: string;
  }): Promise<{ state: CanonicalCacheState | "warming" | "ready"; runId?: string | null }> {
    const { token, projectId, jobId } = config;
    const res = await fetch(
      `${API_BASE}/api/projects/${projectId}/translations/${jobId}/canonical/warmup`,
      {
        method: "POST",
        headers: defaultHeaders(token),
      },
    );
    return handle(res);
  },

  async fetchProofreadSummary(
    token: string,
    projectId: string,
    params: { runId?: string | null; proofreadingId?: string | null },
  ): Promise<ProofreadRunSummary | null> {
    const search = new URLSearchParams();
    if (params.runId) search.set("runId", params.runId);
    if (params.proofreadingId) search.set("proofreadingId", params.proofreadingId);
    const query = search.toString();
    const url = `${API_BASE}/api/projects/${projectId}/proofread/summary${
      query ? `?${query}` : ""
    }`;
    const res = await fetch(url, {
      method: "GET",
      headers: defaultHeaders(token),
    });

    if (res.status === 404) {
      return null;
    }

    const data = await handle<{ summary?: ProofreadRunSummary | null }>(res);
    return data.summary ?? null;
  },

  async fetchTranslationSummary(
    token: string,
    projectId: string,
    params: { runId?: string | null; jobId?: string | null },
  ): Promise<TranslationRunSummary | null> {
    const search = new URLSearchParams();
    if (params.runId) search.set("runId", params.runId);
    if (params.jobId) search.set("jobId", params.jobId);
    const query = search.toString();
    const url = `${API_BASE}/api/projects/${projectId}/translations/summary${
      query ? `?${query}` : ""
    }`;
    const res = await fetch(url, {
      method: "GET",
      headers: defaultHeaders(token),
    });

    if (res.status === 404) {
      return null;
    }

    const data = await handle<{ summary?: TranslationRunSummary | null }>(res);
    return data.summary ?? null;
  },

  async fetchTranslationStageDrafts(config: {
    token: string;
    projectId: string;
    stage: TranslationStageKey;
    jobId?: string | null;
    translationFileId?: string | null;
  }): Promise<TranslationStageDraftResponse> {
    const {
      token,
      projectId,
      stage,
      jobId = null,
      translationFileId = null,
    } = config;
    const search = new URLSearchParams({ stage });
    if (jobId) search.set("jobId", jobId);
    if (translationFileId) search.set("translationFileId", translationFileId);
    const query = search.toString();
    const url = `${API_BASE}/api/projects/${projectId}/translations/stage-drafts${
      query ? `?${query}` : ""
    }`;
    const res = await fetch(url, {
      method: "GET",
      headers: defaultHeaders(token),
    });
    return handle<TranslationStageDraftResponse>(res);
  },

  async patchProofreadEditorSegments(config: {
    token: string;
    projectId: string;
    payload: ProofreadEditorPatchPayload;
  }): Promise<ProofreadEditorPatchResponse> {
    const { token, projectId, payload } = config;
    const {
      translationFileId,
      documentVersion,
      segments,
      jobId,
      clientMutationId,
    } = payload;
    const bodyPayload = {
      translationFileId,
      documentVersion,
      segments,
      jobId: jobId ?? null,
      clientMutationId: clientMutationId ?? null,
    };
    const res = await fetch(
      `${API_BASE}/api/projects/${projectId}/proofread/editor/segments`,
      {
        method: "PATCH",
        headers: defaultHeaders(token),
        body: JSON.stringify(bodyPayload),
      },
    );

    if (res.status === 409) {
      const details = await res.json();
      throw details as ProofreadEditorConflictResponse;
    }

    return handle<ProofreadEditorPatchResponse>(res);
  },

  subscribeProofreadEditorStream(config: {
    token: string;
    projectId: string;
    jobId?: string | null;
    translationFileId?: string | null;
    onEvent?: (event: ProofreadEditorStreamEvent) => void;
    onError?: (error: Error) => void;
  }): () => void {
    const {
      token,
      projectId,
      jobId = null,
      translationFileId = null,
      onEvent,
      onError,
    } = config;
    const controller = new AbortController();
    const search = new URLSearchParams();
    if (jobId) search.set("jobId", jobId);
    if (translationFileId) search.set("translationFileId", translationFileId);
    const query = search.toString();
    const url = `${API_BASE}/api/projects/${projectId}/proofread/editor/stream${
      query ? `?${query}` : ""
    }`;

    const headers: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {};

    fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text();
          throw new Error(
            text || "Failed to subscribe to proofread editor stream",
          );
        }
        const body = res.body;
        if (!body) {
          throw new Error(
            "Streaming body is not supported in this environment",
          );
        }
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newlineIndex: number;
          while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            const trimmed = line.trim();
            if (!trimmed) {
              continue;
            }
            if (trimmed.startsWith(":")) {
              continue;
            }
            if (trimmed.startsWith("data:")) {
              const payload = trimmed.slice(5).trim();
              if (!payload) continue;
              try {
                const event = JSON.parse(payload) as ProofreadEditorStreamEvent;
                onEvent?.(event);
              } catch (err) {
                console.warn(
                  "[api] failed to parse proofread stream event",
                  err,
                );
              }
            }
          }
        }
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        onError?.(error instanceof Error ? error : new Error(String(error)));
      });

    return () => {
      controller.abort();
    };
  },

  async evaluateQuality(
    token: string,
    payload: {
      source: string;
      translated: string;
      authorIntention?: string;
      model?: string;
      maxCharsPerChunk?: number;
      overlap?: number;
      projectId?: string;
      jobId?: string;
      workflowLabel?: string | null;
      workflowAllowParallel?: boolean;
    },
  ): Promise<
    QualityAssessmentResultPayload | { data?: QualityAssessmentResultPayload }
  > {
    const res = await fetch(`${API_BASE}/api/evaluate`, {
      method: "POST",
      headers: defaultHeaders(token),
      body: JSON.stringify(payload),
    });
    return handle<
      QualityAssessmentResultPayload | { data?: QualityAssessmentResultPayload }
    >(res);
  },

  async evaluateQualityStream(
    token: string,
    payload: {
      source: string;
      translated: string;
      authorIntention?: string;
      model?: string;
      maxCharsPerChunk?: number;
      overlap?: number;
      projectId?: string;
      jobId?: string;
      workflowLabel?: string | null;
      workflowAllowParallel?: boolean;
    },
    handlers: {
      onEvent?: (event: QualityStreamEvent) => void;
      signal?: AbortSignal;
    } = {},
  ): Promise<QualityAssessmentResultPayload> {
    const controller = new AbortController();
    if (handlers.signal) {
      const abortViaSignal = () => controller.abort();
      if (handlers.signal.aborted) {
        controller.abort();
      } else {
        handlers.signal.addEventListener("abort", abortViaSignal, {
          once: true,
        });
      }
    }

    const res = await fetch(`${API_BASE}/api/evaluate/stream`, {
      method: "POST",
      headers: defaultHeaders(token),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || "Failed to stream quality assessment");
    }

    let finalResult: QualityAssessmentResultPayload | null = null;
    let streamError: Error | null = null;

    try {
      await streamNdjson<QualityStreamEvent>(res, (event) => {
        handlers.onEvent?.(event);
        if (event.type === "complete") {
          finalResult = event.result;
        }
        if (event.type === "error") {
          streamError = new Error(event.message ?? "Quality stream error");
          controller.abort();
        }
      });
    } catch (err) {
      if (!streamError) {
        streamError =
          err instanceof Error
            ? err
            : new Error(String(err ?? "Unknown error"));
      }
    }

    if (streamError) {
      throw streamError;
    }

    if (!finalResult) {
      throw new Error("Quality stream ended without a result");
    }

    return finalResult;
  },

  async saveQualityAssessment(
    token: string,
    payload: {
      projectId: string;
      jobId?: string;
      sourceText: string;
      translatedText: string;
      qualityResult: QualityAssessmentResultPayload;
      translationMethod?: "auto" | "manual";
      modelUsed?: string;
    },
  ) {
    const res = await fetch(`${API_BASE}/api/quality/save`, {
      method: "POST",
      headers: defaultHeaders(token),
      body: JSON.stringify(payload),
    });
    return handle(res);
  },

  async chatPrompt(): Promise<{ prompt: string }> {
    const res = await fetch(`${API_BASE}/api/chat/prompt`);
    return handle(res);
  },
};

export type ApiClient = typeof api;
