import { Buffer } from 'node:buffer';
import { ObjectId } from 'mongodb';
import type {
  IssueItem,
  ProofreadingReport,
  ResultBucket,
} from '../agents/proofreading/config';
import type { ProofreadStreamMeta } from './proofreadStreamMeta';
import { fetchProofreadStreamMeta } from './proofreadStreamMeta';
import { query } from '../db';
import { getMongo } from '../db/mongo';
import type { AgentItemV2, AgentItemsResponseV2 } from './responsesSchemas';

const toIsoString = (value: Date | string | null | undefined): string | null => {
  if (!value) return null;
  try {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  } catch (error) {
    return null;
  }
};

export interface ProofreadRunSummaryRequest {
  projectId: string;
  runId?: string | null;
  proofreadingId?: string | null;
}

export interface ProofreadRunSummaryResponse {
  projectId: string;
  runId: string | null;
  runStatus: string | null;
  runCreatedAt: string | null;
  runCompletedAt: string | null;
  lastLogAt: string | null;
  jobId: string | null;
  translationFileId: string | null;
  memoryVersion: number | null;
  finalTextHash: string | null;
  proofreading: {
    id: string | null;
    status: string | null;
    createdAt: string | null;
    completedAt: string | null;
  };
  workflowRun: {
    runId: string;
    status: string;
    label: string | null;
    startedAt: string | null;
    completedAt: string | null;
    updatedAt: string | null;
  } | null;
  report: ProofreadingReport | null;
  tierReports: Partial<Record<'quick' | 'deep', ProofreadingReport>>;
  updatedAt: string | null;
  streamMeta: ProofreadStreamMeta | null;
}

const resolveProofreadingIdFromLogs = async (
  runId: string,
): Promise<{ proofreadingId: string; lastLogAt: string | null } | null> => {
  const { rows } = await query(
    `SELECT proofreading_id, MAX(created_at) AS last_created_at
       FROM proofreading_logs
      WHERE run_id = $1
      GROUP BY proofreading_id
      ORDER BY last_created_at DESC
      LIMIT 1`,
    [runId],
  );
  if (!rows.length) return null;
  const row = rows[0] as {
    proofreading_id: string;
    last_created_at: Date | string | null;
  };
  return {
    proofreadingId: row.proofreading_id,
    lastLogAt: toIsoString(row.last_created_at),
  };
};

const resolveLastLogAt = async (
  criteria: { runId?: string | null; proofreadingId?: string | null },
): Promise<string | null> => {
  if (criteria.runId) {
    const mapping = await resolveProofreadingIdFromLogs(criteria.runId);
    if (mapping?.lastLogAt) return mapping.lastLogAt;
  }
  if (criteria.proofreadingId) {
    const { rows } = await query(
      `SELECT MAX(created_at) AS last_created_at
         FROM proofreading_logs
        WHERE proofreading_id = $1`,
      [criteria.proofreadingId],
    );
    const candidate = rows[0]?.last_created_at as Date | string | null | undefined;
    return toIsoString(candidate ?? null);
  }
  return null;
};

const fetchProofreadingHistory = async (
  proofreadingId: string,
): Promise<{
  projectId: string | null;
  jobId: string | null;
  status: string | null;
  createdAt: string | null;
  completedAt: string | null;
} | null> => {
  const { rows } = await query(
    `SELECT project_id, job_id, status, created_at, completed_at
       FROM proofreading_history
      WHERE proofreading_id = $1
      LIMIT 1`,
    [proofreadingId],
  );
  if (!rows.length) return null;
  const row = rows[0] as {
    project_id: string | null;
    job_id: string | null;
    status: string | null;
    created_at: Date | string | null;
    completed_at: Date | string | null;
  };
  return {
    projectId: row.project_id ?? null,
    jobId: row.job_id ?? null,
    status: row.status ?? null,
    createdAt: toIsoString(row.created_at),
    completedAt: toIsoString(row.completed_at),
  };
};

const fetchWorkflowRun = async (
  projectId: string,
  jobId: string | null,
): Promise<ProofreadRunSummaryResponse['workflowRun']> => {
  if (!jobId) return null;
  const { rows } = await query(
    `SELECT run_id, status, label, started_at, completed_at, updated_at
       FROM workflow_runs
      WHERE project_id = $1
        AND type = 'proofread'
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
    startedAt: toIsoString(row.started_at),
    completedAt: toIsoString(row.completed_at),
    updatedAt: toIsoString(row.updated_at),
  };
};

const fetchTranslationFileJobId = async (
  translationFileId: string | null,
): Promise<{ jobId: string | null; updatedAt: string | null } | null> => {
  if (!translationFileId) return null;
  try {
    const objectId = new ObjectId(translationFileId);
    const mongo = await getMongo();
    const doc = await mongo
      .collection('translation_files')
      .findOne({ _id: objectId });
    if (!doc || typeof doc !== 'object') return null;
    const jobId = typeof (doc as { job_id?: unknown }).job_id === 'string'
      ? ((doc as { job_id?: string }).job_id ?? null)
      : null;
    const updatedAt = toIsoString(
      (doc as { updated_at?: Date | string | null }).updated_at ?? null,
    );
    return { jobId, updatedAt };
  } catch (error) {
    return null;
  }
};

const fetchProofreadingDocument = async (
  proofreadingId: string,
): Promise<{
  report: ProofreadingReport | null;
  tierReports: Partial<Record<'quick' | 'deep', ProofreadingReport>>;
  updatedAt: string | null;
} | null> => {
  const mongo = await getMongo();
  const doc = await mongo
    .collection('proofreading_files')
    .findOne({ proofreading_id: proofreadingId });
  if (!doc || typeof doc !== 'object') return null;
  const cast = doc as {
    report?: ProofreadingReport | null;
    quick_report?: ProofreadingReport | null;
    deep_report?: ProofreadingReport | null;
    updated_at?: Date | string | null;
  };
  const tierReports: Partial<Record<'quick' | 'deep', ProofreadingReport>> = {};
  if (cast.quick_report) tierReports.quick = cast.quick_report;
  if (cast.deep_report) tierReports.deep = cast.deep_report;
  return {
    report: cast.report ?? null,
    tierReports,
    updatedAt: toIsoString(cast.updated_at ?? null),
  };
};

export async function getProofreadRunSummary(
  params: ProofreadRunSummaryRequest,
): Promise<ProofreadRunSummaryResponse | null> {
  const { projectId } = params;
  let runId = params.runId ?? null;
  let proofreadingId = params.proofreadingId ?? null;

  if (!runId && !proofreadingId) {
    throw new Error('run_id_or_proofreading_id_required');
  }

  let runRow: (
    | {
        id: string;
        status: string;
        translation_file_id: string | null;
        memory_version: number | null;
        final_text_hash: string | null;
        created_at: Date | string | null;
        updated_at?: Date | string | null;
      }
    | null
  ) = null;

  if (runId) {
    const { rows } = await query(
      `SELECT id, status, translation_file_id, memory_version, final_text_hash, created_at
         FROM proofread_runs
        WHERE id = $1 AND project_id = $2
        LIMIT 1`,
      [runId, projectId],
    );
    runRow = rows[0] ?? null;
    if (!runRow) {
      runId = null;
    }
  }

  let lastLogAt: string | null = null;

  if (runId && !proofreadingId) {
    const mapping = await resolveProofreadingIdFromLogs(runId);
    if (mapping) {
      proofreadingId = mapping.proofreadingId;
      lastLogAt = mapping.lastLogAt;
    }
  }

  if (!lastLogAt) {
    lastLogAt = await resolveLastLogAt({ runId, proofreadingId });
  }

  let history = null;
  if (proofreadingId) {
    history = await fetchProofreadingHistory(proofreadingId);
    if (history && history.projectId && history.projectId !== projectId) {
      history = null;
    }
  }

  let jobId = history?.jobId ?? null;
  const translationFileId = runRow?.translation_file_id ?? null;
  const memoryVersion = runRow?.memory_version ?? null;
  const finalTextHash = runRow?.final_text_hash ?? null;
  const runStatus = runRow?.status ?? null;
  const runCreatedAt = toIsoString(runRow?.created_at ?? null);

  let translationMeta = null;
  if (!jobId && translationFileId) {
    translationMeta = await fetchTranslationFileJobId(translationFileId);
    if (translationMeta?.jobId) {
      jobId = translationMeta.jobId;
    }
  }

  let workflowRun = await fetchWorkflowRun(projectId, jobId);

  if (!workflowRun && history?.jobId) {
    workflowRun = await fetchWorkflowRun(projectId, history.jobId);
  }

  let reportPayload = null;
  if (proofreadingId) {
    reportPayload = await fetchProofreadingDocument(proofreadingId);
  }

  if (!runId && !proofreadingId && !reportPayload) {
    return null;
  }

  const streamMeta = await fetchProofreadStreamMeta(runId ?? null);

  return {
    projectId,
    runId,
    runStatus,
    runCreatedAt,
    runCompletedAt: workflowRun?.completedAt ?? history?.completedAt ?? null,
    lastLogAt,
    jobId,
    translationFileId,
    memoryVersion: memoryVersion ?? null,
    finalTextHash: finalTextHash ?? null,
    proofreading: {
      id: proofreadingId ?? null,
      status: history?.status ?? null,
      createdAt: history?.createdAt ?? null,
      completedAt: history?.completedAt ?? null,
    },
    workflowRun,
    report: reportPayload?.report ?? null,
    tierReports: reportPayload?.tierReports ?? {},
    updatedAt:
      reportPayload?.updatedAt ??
      history?.completedAt ??
      translationMeta?.updatedAt ??
      lastLogAt,
    streamMeta,
  };
}

const severityToAgentSeverity = (
  severity: string | null | undefined,
): 'error' | 'warning' | 'suggestion' => {
  if (!severity) return 'suggestion';
  const normalized = severity.toLowerCase();
  if (normalized === 'high') return 'error';
  if (normalized === 'medium') return 'warning';
  return 'suggestion';
};

const clampNote = (note: string | undefined | null): string | undefined => {
  if (typeof note !== 'string') return undefined;
  if (!note.trim()) return undefined;
  return note.length > 200 ? `${note.slice(0, 197)}…` : note;
};

const computeAverageItemBytes = (items: AgentItemV2[]): number => {
  if (!items.length) return 0;
  const totalBytes = items.reduce((acc, item) => {
    const message = typeof item.r === 'string' ? item.r : '';
    return acc + Buffer.byteLength(message, 'utf8');
  }, 0);
  return Math.max(0, Math.floor(totalBytes / items.length));
};

const toAgentItem = (issue: IssueItem): AgentItemV2 => {
  const span = issue.spans ?? undefined;
  const start = span ? Math.max(0, span.start) : 0;
  const end = span ? Math.max(start, span.end) : start;

  const item: AgentItemV2 = {
    k: issue.id,
    s: severityToAgentSeverity(issue.severity ?? null),
    r: issue.issue_ko ?? issue.issue_en ?? issue.id,
    t: 'note',
    i: [start, start],
    o: [start, end],
    uid: issue.id,
    side: 'tgt',
  };

  if (typeof issue.confidence === 'number' && Number.isFinite(issue.confidence)) {
    item.conf = Math.max(0, Math.min(1, issue.confidence));
  }

  const fixText = clampNote(issue.after ?? issue.recommendation_ko ?? issue.recommendation_en);
  if (fixText) {
    item.fix = { text: fixText };
  }

  return item;
};

type BucketEntry = {
  tier: string | null;
  key: string | null;
  chunkIndex: number | null;
  page: AgentItemsResponseV2;
};

const buildBucketEntry = (
  runId: string,
  tier: string | null,
  bucket: ResultBucket,
  report: ProofreadingReport,
  bucketIndex: number,
): BucketEntry | null => {
  const issues = Array.isArray(bucket.items) ? bucket.items : [];
  if (!issues.length) return null;

  const items = issues.map((issue) => toAgentItem(issue));
  if (!items.length) return null;

  const runs = report.meta?.llm?.runs ?? [];
  const runMeta = runs.find(
    (run) =>
      run.tier === tier &&
      (run.subfeatureKey === bucket.subfeatureKey ||
        run.subfeatureLabel === bucket.subfeatureLabel),
  );

  const chunkIndex = runMeta?.chunkIndex ?? bucketIndex;
  const chunkId = [
    'summary',
    tier ?? 'global',
    bucket.subfeatureKey ?? bucket.subfeatureLabel ?? `bucket-${bucketIndex}`,
    String(chunkIndex ?? bucketIndex),
  ].join(':');

  const promptTokens = runMeta?.usage.promptTokens ?? 0;
  const completionTokens = runMeta?.usage.completionTokens ?? 0;

  const page: AgentItemsResponseV2 = {
    version: 'v2',
    run_id: runId,
    chunk_id: chunkId,
    tier: tier ?? 'summary',
    model: runMeta?.model ?? 'proofread-summary',
    latency_ms: 0,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    finish_reason: undefined,
    truncated: false,
    warnings: [],
    index_base: 0,
    offset_semantics: '[start,end)',
    stats: {
      item_count: items.length,
      avg_item_bytes: computeAverageItemBytes(items),
    },
    metrics: {
      downshift_count: runMeta?.downshiftCount ?? 0,
      forced_pagination: Boolean(runMeta?.forcedPaginationCount && runMeta.forcedPaginationCount > 0),
      cursor_retry_count: runMeta?.cursorRetryCount ?? 0,
    },
    items,
    segment_hashes: [],
    has_more: false,
    next_cursor: null,
    provider_response_id: runMeta?.requestId ?? null,
  };

  return {
    tier,
    key: bucket.subfeatureKey ?? bucket.subfeatureLabel ?? null,
    chunkIndex,
    page,
  };
};

const collectBucketEntries = (
  summary: ProofreadRunSummaryResponse,
  runId: string,
): BucketEntry[] => {
  const entries: BucketEntry[] = [];
  const tierReports = summary.tierReports ?? {};
  const hasTierReports = Object.values(tierReports).some((report) => Boolean(report));

  const pushReportBuckets = (tier: string | null, report: ProofreadingReport) => {
    (report.results ?? []).forEach((bucket, index) => {
      const entry = buildBucketEntry(runId, tier, bucket, report, index);
      if (entry) {
        entries.push(entry);
      }
    });
  };

  if (hasTierReports) {
    if (tierReports.quick) {
      pushReportBuckets('quick', tierReports.quick);
    }
    if (tierReports.deep) {
      pushReportBuckets('deep', tierReports.deep);
    }
  } else if (summary.report) {
    pushReportBuckets(null, summary.report);
  }

  return entries;
};

export interface ProofreadItemsSliceEvent {
  type: 'items';
  data: {
    project_id: string;
    run_id: string;
    proofreading_id: string | null;
    tier: string | null;
    key: string | null;
    chunk_index: number | null;
    page: AgentItemsResponseV2;
  };
}

export interface ProofreadItemsSlice {
  events: ProofreadItemsSliceEvent[];
  nextCursor: string | null;
  hasMore: boolean;
  total: number;
}

export function buildProofreadItemsSliceFromSummary(
  summary: ProofreadRunSummaryResponse,
  params: {
    fallbackRunId: string;
    cursor?: string | null;
    limit?: number | null;
  },
):
  | {
      resolvedRunId: string;
      slice: ProofreadItemsSlice;
    }
  | null {
  const resolvedRunId = summary.runId ?? params.fallbackRunId ?? summary.proofreading.id ?? null;
  if (!resolvedRunId) {
    return null;
  }

  const entries = collectBucketEntries(summary, resolvedRunId);
  const total = entries.length;
  const limit = Math.min(Math.max(Number(params.limit ?? 2) || 2, 1), 10);
  const offsetRaw = params.cursor ? Number(params.cursor) : 0;
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.min(offsetRaw, total) : 0;

  const sliceEntries = entries.slice(offset, offset + limit);
  const nextCursor = offset + sliceEntries.length < total ? String(offset + sliceEntries.length) : null;

  const events: ProofreadItemsSliceEvent[] = sliceEntries.map((entry) => ({
    type: 'items',
    data: {
      project_id: summary.projectId,
      run_id: resolvedRunId,
      proofreading_id: summary.proofreading.id ?? null,
      tier: entry.tier,
      key: entry.key,
      chunk_index: entry.chunkIndex,
      page: entry.page,
    },
  }));

  return {
    resolvedRunId,
    slice: {
      events,
      nextCursor,
      hasMore: nextCursor !== null,
      total,
    },
  };
}

export async function getProofreadItemsSlice(params: {
  projectId: string;
  runId: string;
  cursor?: string | null;
  limit?: number | null;
}): Promise<
  | {
      summary: ProofreadRunSummaryResponse;
      slice: ProofreadItemsSlice;
    }
  | null
> {
  const { projectId, runId } = params;
  const summary = await getProofreadRunSummary({
    projectId,
    runId,
    proofreadingId: null,
  });

  if (!summary) {
    return null;
  }

  const built = buildProofreadItemsSliceFromSummary(summary, {
    fallbackRunId: runId,
    cursor: params.cursor ?? null,
    limit: params.limit ?? null,
  });

  if (!built) {
    return null;
  }

  return {
    summary,
    slice: built.slice,
  };
}
