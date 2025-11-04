import { randomUUID } from "crypto";
import { query } from "../db";
import {
  recordProofreadLog,
  listProofreadLogsFromMemory,
} from "../services/proofreadTelemetry";

export type ProofreadingLogSeverity = "info" | "warn" | "error";

let extendedColumnsAvailable = true;

function isMissingColumnError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code === "42703") return true;
  const message =
    typeof (error as { message?: unknown } | null)?.message === "string"
      ? ((error as { message: string }).message ?? "")
      : "";
  if (!message) return false;
  if (!message.includes("column")) return false;
  return (
    message.includes("downshift") ||
    message.includes("forced_pagination") ||
    message.includes("cursor_retry")
  );
}

export interface ProofreadingLogEntry {
  id: string;
  project_id: string;
  job_id: string;
  proofreading_id: string;
  run_id: string;
  tier: "quick" | "deep";
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
  created_at: Date;
  downshift_attempts?: number | null;
  forced_pagination?: number | null;
  cursor_retry?: number | null;
}

export async function insertProofreadingLog(payload: {
  projectId: string;
  jobId: string;
  proofreadingId: string;
  runId: string;
  tier: "quick" | "deep";
  subfeatureKey: string;
  subfeatureLabel: string;
  chunkIndex: number;
  meta: {
    model: string;
    maxOutputTokens: number;
    attempts: number;
    truncated: boolean;
    requestId: string | null;
    guardSegments: number;
    memoryContextVersion: number | null;
    usage: {
      promptTokens: number | null;
      completionTokens: number | null;
      totalTokens: number | null;
    };
    verbosity: string;
    reasoningEffort: string;
    downshiftAttempts?: number;
    forcedPagination?: number;
    cursorRetry?: number;
  };
}): Promise<void> {
  const entry: ProofreadingLogEntry = {
    id: randomUUID(),
    project_id: payload.projectId,
    job_id: payload.jobId,
    proofreading_id: payload.proofreadingId,
    run_id: payload.runId,
    tier: payload.tier,
    subfeature_key: payload.subfeatureKey,
    subfeature_label: payload.subfeatureLabel,
    chunk_index: payload.chunkIndex,
    model: payload.meta.model,
    max_output_tokens: payload.meta.maxOutputTokens,
    attempts: payload.meta.attempts,
    truncated: payload.meta.truncated,
    request_id: payload.meta.requestId,
    guard_segments: payload.meta.guardSegments,
    memory_version: payload.meta.memoryContextVersion,
    usage_prompt_tokens: payload.meta.usage.promptTokens,
    usage_completion_tokens: payload.meta.usage.completionTokens,
    usage_total_tokens: payload.meta.usage.totalTokens,
    verbosity: payload.meta.verbosity,
    reasoning_effort: payload.meta.reasoningEffort,
    created_at: new Date(),
    downshift_attempts: payload.meta.downshiftAttempts ?? 0,
    forced_pagination: payload.meta.forcedPagination ?? 0,
    cursor_retry: payload.meta.cursorRetry ?? 0,
  };

  recordProofreadLog(entry);

  const baseParams = [
    entry.project_id,
    entry.job_id,
    entry.proofreading_id,
    entry.run_id,
    entry.tier,
    entry.subfeature_key,
    entry.subfeature_label,
    entry.chunk_index,
    entry.model,
    entry.max_output_tokens,
    entry.attempts,
    entry.truncated,
    entry.request_id,
    entry.guard_segments,
    entry.memory_version,
    entry.usage_prompt_tokens,
    entry.usage_completion_tokens,
    entry.usage_total_tokens,
    entry.verbosity,
    entry.reasoning_effort,
  ];

  if (extendedColumnsAvailable) {
    try {
      await query(
        `INSERT INTO proofreading_logs (
            project_id,
            job_id,
            proofreading_id,
            run_id,
            tier,
            subfeature_key,
            subfeature_label,
            chunk_index,
            model,
            max_output_tokens,
            attempts,
            truncated,
            request_id,
            guard_segments,
            memory_version,
            usage_prompt_tokens,
            usage_completion_tokens,
            usage_total_tokens,
            verbosity,
            reasoning_effort,
            downshift_attempts,
            forced_pagination,
            cursor_retry
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            $11,
            $12,
            $13,
            $14,
            $15,
            $16,
            $17,
            $18,
            $19,
            $20,
            $21,
            $22,
            $23
          )`,
        [
          ...baseParams,
          entry.downshift_attempts ?? 0,
          entry.forced_pagination ?? 0,
          entry.cursor_retry ?? 0,
        ],
      );
      return;
    } catch (error) {
      if (isMissingColumnError(error)) {
        extendedColumnsAvailable = false;
        console.warn(
          "[proofreading_logs] missing extended columns; falling back to legacy insert",
        );
      } else {
        throw error;
      }
    }
  }

  await query(
    `INSERT INTO proofreading_logs (
        project_id,
        job_id,
        proofreading_id,
        run_id,
        tier,
        subfeature_key,
        subfeature_label,
        chunk_index,
        model,
        max_output_tokens,
        attempts,
        truncated,
        request_id,
        guard_segments,
        memory_version,
        usage_prompt_tokens,
        usage_completion_tokens,
        usage_total_tokens,
        verbosity,
        reasoning_effort
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14,
        $15,
        $16,
        $17,
        $18,
        $19,
        $20
      )`,
    baseParams,
  );
}

export async function listProofreadingLogs(config: {
  projectId?: string;
  limit?: number;
}): Promise<ProofreadingLogEntry[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (config.projectId) {
    params.push(config.projectId);
    where.push(`project_id = $${params.length}`);
  }

  const limitParam = config.limit ?? 100;
  const queryText = extendedColumnsAvailable
    ? `
        SELECT id,
               project_id,
               job_id,
               proofreading_id,
               run_id,
               tier,
               subfeature_key,
               subfeature_label,
               chunk_index,
               model,
               max_output_tokens,
               attempts,
               truncated,
               request_id,
               guard_segments,
               memory_version,
               usage_prompt_tokens,
               usage_completion_tokens,
               usage_total_tokens,
               verbosity,
               reasoning_effort,
               downshift_attempts,
               forced_pagination,
               cursor_retry,
               created_at
          FROM proofreading_logs
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY created_at DESC
          LIMIT $${params.push(limitParam)}
      `
    : `
        SELECT id,
               project_id,
               job_id,
               proofreading_id,
               run_id,
               tier,
               subfeature_key,
               subfeature_label,
               chunk_index,
               model,
               max_output_tokens,
               attempts,
               truncated,
               request_id,
               guard_segments,
               memory_version,
               usage_prompt_tokens,
               usage_completion_tokens,
               usage_total_tokens,
               verbosity,
               reasoning_effort,
               created_at
          FROM proofreading_logs
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY created_at DESC
          LIMIT $${params.push(limitParam)}
      `;

  try {
    const { rows } = await query(queryText, params);
    if (rows.length) return rows as ProofreadingLogEntry[];
  } catch (error) {
    if (extendedColumnsAvailable && isMissingColumnError(error)) {
      extendedColumnsAvailable = false;
      console.warn(
        "[proofreading_logs] extended columns missing; retrying without counters",
      );
      return listProofreadingLogs(config);
    }
    console.error("[proofreading] failed to fetch logs from db", error);
  }

  return listProofreadLogsFromMemory(config);
}
