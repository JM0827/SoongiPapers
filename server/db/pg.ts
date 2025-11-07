import { pool, query as dbQuery } from "../db";

const TABLE_MISSING_CODE = "42P01";

type PgError = Error & { code?: string };

const isPgError = (error: unknown): error is PgError =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof (error as { code?: unknown }).code === "string";

async function safeQuery(sql: string, params: any[], context: string) {
  try {
    await dbQuery(sql, params);
    return true;
  } catch (error) {
    if (isPgError(error) && error.code === TABLE_MISSING_CODE) {
      console.warn(`[Proofreading][PG] Skipping ${context}: ${error.message}`);
      return false;
    }
    throw error;
  }
}

export async function insertHistory(params: {
  project_id: string;
  job_id: string;
  proofreading_id: string;
  status: "requested" | "inprogress" | "completed" | "error";
}) {
  const { project_id, job_id, proofreading_id, status } = params;
  if (!project_id?.trim() || !job_id?.trim()) {
    throw new Error(
      "insertHistory requires project_id and job_id to be provided",
    );
  }
  await safeQuery(
    `INSERT INTO proofreading_history (project_id, job_id, proofreading_id, status)
     VALUES ($1,$2,$3,$4)`,
    [project_id, job_id, proofreading_id, status],
    "proofreading_history insert",
  );
}
export async function updateHistory(params: {
  proofreading_id: string;
  status: "requested" | "inprogress" | "completed" | "error";
}) {
  const { proofreading_id, status } = params;
  await safeQuery(
    `UPDATE proofreading_history
       SET status=$1,
           completed_at = CASE WHEN $1 IN ('completed','error') THEN NOW() ELSE completed_at END
     WHERE proofreading_id=$2`,
    [status, proofreading_id],
    "proofreading_history update",
  );
}

export async function markInProgressHistoryAsError(
  project_id: string,
  job_id: string,
) {
  await safeQuery(
    `UPDATE proofreading_history
       SET status='error', completed_at = NOW()
     WHERE project_id=$1 AND job_id=$2 AND status='inprogress'`,
    [project_id, job_id],
    "proofreading_history mark stale",
  );
}

export async function findProofreadRun(params: {
  projectId: string;
  translationFileId: string;
  memoryVersion: number | null;
  finalTextHash: string;
}) {
  const { projectId, translationFileId, memoryVersion, finalTextHash } = params;
  const { rows } = await dbQuery(
    `SELECT id, status
       FROM proofread_runs
      WHERE project_id = $1
        AND translation_file_id = $2
        AND memory_version IS NOT DISTINCT FROM $3
        AND final_text_hash = $4
      LIMIT 1`,
    [projectId, translationFileId, memoryVersion, finalTextHash],
  );
  return rows[0] ?? null;
}

export async function upsertProofreadRun(params: {
  projectId: string;
  translationFileId: string;
  memoryVersion: number | null;
  finalTextHash: string;
  status: string;
}) {
  const { projectId, translationFileId, memoryVersion, finalTextHash, status } =
    params;
  const { rows } = await dbQuery(
    `INSERT INTO proofread_runs (
        project_id,
        translation_file_id,
        memory_version,
        final_text_hash,
        status
      )
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (project_id, translation_file_id, memory_version, final_text_hash)
      DO UPDATE SET
        status = EXCLUDED.status,
        created_at = NOW()
      RETURNING id, status, created_at`,
    [projectId, translationFileId, memoryVersion, finalTextHash, status],
  );
  return rows[0];
}

export async function updateProofreadRunStatus(
  proofreadRunId: string,
  status: string,
) {
  await dbQuery(
    `UPDATE proofread_runs
        SET status = $2
      WHERE id = $1`,
    [proofreadRunId, status],
  );
}

export async function findProofreadRunById(params: {
  projectId: string;
  proofreadRunId: string;
}) {
  const { projectId, proofreadRunId } = params;
  const { rows } = await dbQuery(
    `SELECT id, status
       FROM proofread_runs
      WHERE id = $1 AND project_id = $2
      LIMIT 1`,
    [proofreadRunId, projectId],
  );
  return rows[0] ?? null;
}
