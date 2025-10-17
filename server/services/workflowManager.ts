import { query } from "../db";
import { workflowEvents, WORKFLOW_EVENTS } from "./workflowEvents";

export type WorkflowType = "translation" | "proofread" | "quality";
export type WorkflowRunStatus =
  | "running"
  | "pending"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface WorkflowRunRecord {
  runId: string;
  projectId: string;
  type: WorkflowType;
  status: WorkflowRunStatus;
  requestedBy: string | null;
  intentText: string | null;
  label: string | null;
  parentRunId: string | null;
  metadata: Record<string, unknown> | null;
  startedAt: string;
  completedAt: string | null;
  updatedAt: string;
  sequence: number;
}

export interface RequestActionOptions {
  projectId: string;
  type: WorkflowType;
  requestedBy?: string | null;
  intentText?: string | null;
  label?: string | null;
  parentRunId?: string | null;
  metadata?: Record<string, unknown> | null;
  allowParallel?: boolean;
}

export interface RequestActionResult {
  accepted: boolean;
  reason?: string;
  projectStatus?: string | null;
  run?: WorkflowRunRecord;
  conflictRun?: WorkflowRunRecord | null;
  conflictStatus?: WorkflowRunStatus | "pending" | null;
}

export interface WorkflowSummary {
  state: Array<{
    type: WorkflowType;
    status: WorkflowRunStatus | "idle";
    label: string | null;
    currentRunId: string | null;
    updatedAt: string | null;
  }>;
  recentRuns: WorkflowRunRecord[];
}

const AUTO_CANCEL_STATUSES = new Set(["completed", "deleted"]);
const BLOCKING_STATUSES = new Set<WorkflowRunStatus | "pending">([
  "running",
  "pending",
]);

const PARENT_LABEL_SUFFIX: Record<WorkflowType, string> = {
  translation: "Translation",
  proofread: "Proofread",
  quality: "Quality",
};

const capitalize = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1);

const mapRunRow = (row: any, sequence = 0): WorkflowRunRecord => ({
  runId: row.run_id,
  projectId: row.project_id,
  type: row.type,
  status: row.status,
  requestedBy: row.requested_by ?? null,
  intentText: row.intent_text ?? null,
  label: row.label ?? null,
  parentRunId: row.parent_run_id ?? null,
  metadata: row.metadata ?? null,
  startedAt: row.started_at?.toISOString?.() ?? row.started_at,
  completedAt: row.completed_at?.toISOString?.() ?? row.completed_at ?? null,
  updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
  sequence,
});

function emitRunLifecycleEvent(
  status: WorkflowRunStatus,
  run: WorkflowRunRecord,
) {
  const payload = { run };
  switch (status) {
    case "succeeded":
      workflowEvents.emit(WORKFLOW_EVENTS.RUN_COMPLETED, payload);
      break;
    case "failed":
      workflowEvents.emit(WORKFLOW_EVENTS.RUN_FAILED, payload);
      break;
    case "cancelled":
      workflowEvents.emit(WORKFLOW_EVENTS.RUN_CANCELLED, payload);
      break;
    default:
      break;
  }
}

async function loadRunById(runId: string): Promise<WorkflowRunRecord | null> {
  const { rows } = await query(
    `SELECT * FROM workflow_runs WHERE run_id = $1 LIMIT 1`,
    [runId],
  );
  if (!rows.length) return null;
  return mapRunRow(rows[0]);
}

async function fetchWorkflowState(
  projectId: string,
  type: WorkflowType,
): Promise<{
  current_run_id: string | null;
  status: WorkflowRunStatus | "idle" | "pending" | null;
} | null> {
  const { rows } = await query(
    `SELECT current_run_id, status
       FROM workflow_state
       WHERE project_id = $1 AND type = $2
       LIMIT 1`,
    [projectId, type],
  );
  if (!rows.length) return null;
  const row = rows[0];
  return {
    current_run_id: row.current_run_id ?? null,
    status: row.status ?? "idle",
  };
}

async function fetchProjectStatus(projectId: string) {
  const { rows } = await query(
    `SELECT status FROM translationprojects WHERE project_id = $1 LIMIT 1`,
    [projectId],
  );
  if (!rows.length) {
    throw new Error(`Project ${projectId} not found`);
  }
  return rows[0].status ?? "active";
}

async function fetchLatestTranslationRun(projectId: string) {
  const { rows } = await query(
    `SELECT run_id, label FROM workflow_runs
       WHERE project_id = $1 AND type = 'translation'
       ORDER BY started_at DESC
       LIMIT 1`,
    [projectId],
  );
  if (!rows.length) return null;
  return {
    runId: rows[0].run_id as string,
    label: rows[0].label as string | null,
  };
}

async function determineNextSequence(
  projectId: string,
  type: WorkflowType,
): Promise<number> {
  const { rows } = await query(
    `SELECT COUNT(*)::INTEGER AS run_count
       FROM workflow_runs
       WHERE project_id = $1 AND type = $2`,
    [projectId, type],
  );
  const runCount = rows[0]?.run_count ?? 0;
  return (runCount as number) + 1;
}

export async function requestAction(
  options: RequestActionOptions,
): Promise<RequestActionResult> {
  const {
    projectId,
    type,
    requestedBy = null,
    intentText = null,
    metadata = null,
  } = options;

  const projectStatus = await fetchProjectStatus(projectId);
  if (AUTO_CANCEL_STATUSES.has(projectStatus)) {
    return {
      accepted: false,
      reason: "project_inactive",
      projectStatus,
    };
  }

  const currentState = await fetchWorkflowState(projectId, type);
  if (
    currentState &&
    BLOCKING_STATUSES.has(
      (currentState.status ?? "idle") as WorkflowRunStatus | "pending",
    ) &&
    options.allowParallel !== true
  ) {
    const conflictRun = currentState.current_run_id
      ? await loadRunById(currentState.current_run_id)
      : null;
    return {
      accepted: false,
      reason: "already_running",
      projectStatus,
      conflictRun,
      conflictStatus: (currentState.status ?? "pending") as
        | WorkflowRunStatus
        | "pending",
    };
  }

  let parentRunId = options.parentRunId ?? null;
  let label = options.label ?? null;

  const parent =
    type === "translation" ? null : await fetchLatestTranslationRun(projectId);

  if (!parentRunId && parent?.runId) {
    parentRunId = parent.runId;
  }

  if (!label) {
    if (type === "translation") {
      label = `Translation run ${new Date().toISOString().slice(0, 10)}`;
    } else if (parent?.label) {
      label = `${parent.label} · ${PARENT_LABEL_SUFFIX[type]}`;
    } else {
      label = `${capitalize(type)} run`;
    }
  }

  const sequence = await determineNextSequence(projectId, type);

  const runInsert = await query(
    `INSERT INTO workflow_runs (
        project_id,
        type,
        status,
        requested_by,
        intent_text,
        label,
        parent_run_id,
        metadata
      )
      VALUES ($1, $2, 'running', $3, $4, $5, $6, $7::jsonb)
      RETURNING *`,
    [
      projectId,
      type,
      requestedBy,
      intentText,
      label,
      parentRunId,
      metadata ? JSON.stringify(metadata) : null,
    ],
  );

  const runRow = runInsert.rows[0];
  const run = mapRunRow(runRow, sequence);

  await query(
    `INSERT INTO workflow_state (project_id, type, current_run_id, status, label, updated_at)
     VALUES ($1, $2, $3, 'running', $4, NOW())
     ON CONFLICT (project_id, type)
     DO UPDATE SET
       current_run_id = EXCLUDED.current_run_id,
       status = EXCLUDED.status,
       label = EXCLUDED.label,
       updated_at = EXCLUDED.updated_at`,
    [projectId, type, run.runId, label],
  );

  workflowEvents.emit(WORKFLOW_EVENTS.RUN_STARTED, { run });

  return { accepted: true, run };
}

async function updateRunStatus(
  runId: string,
  status: WorkflowRunStatus,
  extra?: { metadata?: Record<string, unknown> | null },
) {
  const updates: string[] = ["status = $2", "updated_at = NOW()"];
  const params: any[] = [runId, status];

  if (extra?.metadata) {
    updates.push("metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb");
    params.push(JSON.stringify(extra.metadata));
  }

  const { rows } = await query(
    `UPDATE workflow_runs
       SET ${updates.join(", ")},
           completed_at = CASE WHEN $2 IN ('succeeded','failed','cancelled') THEN NOW() ELSE completed_at END
       WHERE run_id = $1
       RETURNING *`,
    params,
  );
  if (!rows.length) {
    throw new Error(`Workflow run ${runId} not found`);
  }
  const runRow = rows[0];
  const run = mapRunRow(runRow);

  emitRunLifecycleEvent(status, run);

  await query(
    `UPDATE workflow_state
       SET status = $2,
           updated_at = NOW(),
           current_run_id = CASE WHEN current_run_id = $1 THEN $1 ELSE current_run_id END
       WHERE current_run_id = $1`,
    [runId, status],
  );

  return run;
}

export async function completeAction(
  runId: string,
  metadata?: Record<string, unknown>,
) {
  return updateRunStatus(runId, "succeeded", { metadata });
}

export async function failAction(
  runId: string,
  metadata?: Record<string, unknown>,
) {
  return updateRunStatus(runId, "failed", { metadata });
}

export async function cancelAction(
  runId: string,
  metadata?: Record<string, unknown>,
) {
  return updateRunStatus(runId, "cancelled", { metadata });
}

export async function getWorkflowSummary(
  projectId: string,
  limit = 25,
): Promise<WorkflowSummary> {
  const stateRes = await query(
    `SELECT project_id, type, current_run_id, status, label, updated_at
       FROM workflow_state
       WHERE project_id = $1
       ORDER BY type`,
    [projectId],
  );

  const runsRes = await query(
    `SELECT *,
            ROW_NUMBER() OVER (PARTITION BY type ORDER BY started_at ASC) AS seq
       FROM workflow_runs
       WHERE project_id = $1
       ORDER BY started_at DESC
       LIMIT $2`,
    [projectId, limit],
  );

  const state = stateRes.rows.map((row) => ({
    type: row.type as WorkflowType,
    status: (row.status ?? "idle") as WorkflowRunStatus | "idle",
    label: row.label ?? null,
    currentRunId: row.current_run_id ?? null,
    updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at ?? null,
  }));

  const recentRuns = runsRes.rows.map((row) =>
    mapRunRow(row, Number(row.seq ?? 0)),
  );

  return { state, recentRuns };
}

export async function markProjectRunsCancelled(
  projectId: string,
  reason: string,
) {
  const { rows } = await query(
    `UPDATE workflow_runs
       SET status = 'cancelled',
           updated_at = NOW(),
           completed_at = NOW(),
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('cancel_reason', $2)
       WHERE project_id = $1 AND status = 'running'
       RETURNING *`,
    [projectId, reason],
  );

  for (const row of rows) {
    const run = mapRunRow(row);
    emitRunLifecycleEvent("cancelled", run);
  }

  await query(
    `UPDATE workflow_state
       SET status = 'cancelled',
           updated_at = NOW()
       WHERE project_id = $1 AND status = 'running'`,
    [projectId],
  );
}

export async function ensureProjectIsActive(projectId: string) {
  const status = await fetchProjectStatus(projectId);
  if (AUTO_CANCEL_STATUSES.has(status)) {
    throw new Error(`Project ${projectId} is marked as ${status}`);
  }
}
