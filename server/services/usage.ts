import { randomUUID } from "crypto";
import { FastifyBaseLogger } from "fastify";
import { query } from "../db";

export type UsageEventType =
  | "translate"
  | "translate_v2_draft"
  | "translate_v2_revise"
  | "quality"
  | "proofread"
  | "ebook"
  | "profile";

export interface UsageEventInput {
  project_id?: string | null;
  job_id?: string | null;
  batch_id?: string | null;
  event_type: UsageEventType;
  model?: string | null;
  input_tokens?: number;
  output_tokens?: number;
  total_cost?: number | null;
  duration_ms?: number | null;
  metadata?: Record<string, unknown> | null;
}

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 0.000005, output: 0.000015 },
  "gpt-4o-mini": { input: 0.0000006, output: 0.0000024 },
  default: { input: 0.000001, output: 0.0000025 },
};

export function estimateCost(
  model: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
) {
  const pricing = (model && MODEL_PRICING[model]) || MODEL_PRICING.default;
  const inputCost = (inputTokens / 1000) * pricing.input;
  const outputCost = (outputTokens / 1000) * pricing.output;
  return Number((inputCost + outputCost).toFixed(6));
}

export async function recordTokenUsage(
  log: FastifyBaseLogger,
  event: UsageEventInput,
) {
  if (!event.project_id) return;

  const projectId = event.project_id;
  const jobId = event.job_id ?? null;
  const batchId = event.batch_id ?? null;
  const model = event.model ?? null;
  const inputTokens = event.input_tokens ?? 0;
  const outputTokens = event.output_tokens ?? 0;
  const durationMs = event.duration_ms ?? null;
  const cost =
    event.total_cost ?? estimateCost(model, inputTokens, outputTokens);
  const metadataJson = event.metadata ? JSON.stringify(event.metadata) : null;

  const usageParams = [
    randomUUID(),
    projectId,
    jobId,
    batchId,
    event.event_type,
    model,
    inputTokens,
    outputTokens,
    cost,
    durationMs,
  ] as const;

  try {
    await insertUsageEventRow(log, usageParams, metadataJson);

    await query(
      `INSERT INTO project_usage_totals (project_id, total_input_tokens, total_output_tokens, total_cost, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (project_id) DO UPDATE SET
         total_input_tokens = project_usage_totals.total_input_tokens + EXCLUDED.total_input_tokens,
         total_output_tokens = project_usage_totals.total_output_tokens + EXCLUDED.total_output_tokens,
         total_cost = project_usage_totals.total_cost + EXCLUDED.total_cost,
         updated_at = now()`,
      [projectId, inputTokens, outputTokens, cost],
    );
  } catch (err) {
    log.warn(
      { err },
      `[USAGE] Failed to record usage for project ${projectId}`,
    );
  }
}

let metadataColumnAvailable = true;

function isMissingColumnError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code === "42703") {
    return true;
  }
  const message =
    typeof (error as { message?: unknown } | null)?.message === "string"
      ? ((error as { message: string }).message ?? "")
      : "";
  return message.includes("column") && message.includes("metadata");
}

async function insertUsageEventRow(
  log: FastifyBaseLogger,
  params: readonly [
    string,
    string,
    string | null,
    string | null,
    UsageEventType,
    string | null,
    number,
    number,
    number,
    number | null,
  ],
  metadataJson: string | null,
) {
  if (metadataColumnAvailable) {
    try {
      await query(
        `INSERT INTO token_usage_events
           (id, project_id, job_id, batch_id, event_type, model, input_tokens, output_tokens, total_cost, duration_ms, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [...params, metadataJson],
      );
      return;
    } catch (error) {
      if (isMissingColumnError(error)) {
        metadataColumnAvailable = false;
        log.warn(
          {
            err: error,
          },
          "[USAGE] token_usage_events.metadata column missing; reverting to legacy insert",
        );
      } else {
        throw error;
      }
    }
  }

  await query(
    `INSERT INTO token_usage_events
       (id, project_id, job_id, batch_id, event_type, model, input_tokens, output_tokens, total_cost, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [...params],
  );
}
