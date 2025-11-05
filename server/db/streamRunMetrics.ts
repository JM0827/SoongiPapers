import { query } from "../db";

export type RunType = "intake" | "translate" | "proofread" | "quality";

export type RunStatus = "running" | "done" | "error";

export interface StreamRunMetricsRow {
  run_id: string;
  project_id: string | null;
  run_type: RunType | null;
  stage: string | null;
  status: RunStatus | null;
  error_code: string | null;
  error_message: string | null;
  connection_count: number;
  reconnect_attempts: number;
  sse_disconnects: number;
  last_connection_at: Date | null;
  last_disconnection_at: Date | null;
  last_heartbeat_at: Date | null;
  last_event_at: Date | null;
  last_event_type: string | null;
  fallback_count: number;
  last_fallback_at: Date | null;
  last_fallback_reason: string | null;
  downshift_count: number;
  forced_pagination_count: number;
  cursor_retry_count: number;
  last_downshift_at: Date | null;
  model: string | null;
  max_output_tokens: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: string | null;
  extras: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export interface StreamRunMetricsUpsert {
  runId: string;
  projectId: string | null;
  runType?: RunType | null;
  stage?: string | null;
  status?: RunStatus | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  connectionCount?: number;
  reconnectAttempts?: number;
  sseDisconnects?: number;
  lastConnectionAt?: string | null;
  lastDisconnectionAt?: string | null;
  lastHeartbeatAt?: string | null;
  lastEventAt?: string | null;
  lastEventType?: string | null;
  fallbackCount?: number;
  lastFallbackAt?: string | null;
  lastFallbackReason?: string | null;
  downshiftCount?: number;
  forcedPaginationCount?: number;
  cursorRetryCount?: number;
  lastDownshiftAt?: string | null;
  model?: string | null;
  maxOutputTokens?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  extras?: Record<string, unknown>;
}

export const upsertStreamRunMetrics = async (
  payload: StreamRunMetricsUpsert,
): Promise<void> => {
  const connectionCount = payload.connectionCount ?? 0;
  const reconnectAttempts = payload.reconnectAttempts ?? 0;
  const sseDisconnects = payload.sseDisconnects ?? 0;
  const fallbackCount = payload.fallbackCount ?? 0;
  const downshiftCount = payload.downshiftCount ?? 0;
  const forcedPaginationCount = payload.forcedPaginationCount ?? 0;
  const cursorRetryCount = payload.cursorRetryCount ?? 0;
  const extrasJson = JSON.stringify(payload.extras ?? {});

  await query(
    `INSERT INTO stream_run_metrics (
        run_id,
        project_id,
        run_type,
        stage,
        status,
        error_code,
        error_message,
        connection_count,
        reconnect_attempts,
        sse_disconnects,
        last_connection_at,
        last_disconnection_at,
        last_heartbeat_at,
        last_event_at,
        last_event_type,
        fallback_count,
        last_fallback_at,
        last_fallback_reason,
        downshift_count,
        forced_pagination_count,
        cursor_retry_count,
        last_downshift_at,
        model,
        max_output_tokens,
        tokens_in,
        tokens_out,
        cost_usd,
        extras
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
        $19, $20, $21, $22, $23, $24, $25, $26, $27, $28
      )
      ON CONFLICT (run_id) DO UPDATE SET
        project_id = EXCLUDED.project_id,
        run_type = EXCLUDED.run_type,
        stage = EXCLUDED.stage,
        status = EXCLUDED.status,
        error_code = EXCLUDED.error_code,
        error_message = EXCLUDED.error_message,
        connection_count = EXCLUDED.connection_count,
        reconnect_attempts = EXCLUDED.reconnect_attempts,
        sse_disconnects = EXCLUDED.sse_disconnects,
        last_connection_at = EXCLUDED.last_connection_at,
        last_disconnection_at = EXCLUDED.last_disconnection_at,
        last_heartbeat_at = EXCLUDED.last_heartbeat_at,
        last_event_at = EXCLUDED.last_event_at,
        last_event_type = EXCLUDED.last_event_type,
        fallback_count = EXCLUDED.fallback_count,
        last_fallback_at = EXCLUDED.last_fallback_at,
        last_fallback_reason = EXCLUDED.last_fallback_reason,
        downshift_count = EXCLUDED.downshift_count,
        forced_pagination_count = EXCLUDED.forced_pagination_count,
        cursor_retry_count = EXCLUDED.cursor_retry_count,
        last_downshift_at = EXCLUDED.last_downshift_at,
        model = EXCLUDED.model,
        max_output_tokens = EXCLUDED.max_output_tokens,
        tokens_in = EXCLUDED.tokens_in,
        tokens_out = EXCLUDED.tokens_out,
        cost_usd = EXCLUDED.cost_usd,
        extras = EXCLUDED.extras,
        updated_at = NOW()`,
    [
      payload.runId,
      payload.projectId,
      payload.runType ?? null,
      payload.stage ?? null,
      payload.status ?? null,
      payload.errorCode ?? null,
      payload.errorMessage ?? null,
      connectionCount,
      reconnectAttempts,
      sseDisconnects,
      payload.lastConnectionAt ?? null,
      payload.lastDisconnectionAt ?? null,
      payload.lastHeartbeatAt ?? null,
      payload.lastEventAt ?? null,
      payload.lastEventType ?? null,
      fallbackCount,
      payload.lastFallbackAt ?? null,
      payload.lastFallbackReason ?? null,
      downshiftCount,
      forcedPaginationCount,
      cursorRetryCount,
      payload.lastDownshiftAt ?? null,
      payload.model ?? null,
      payload.maxOutputTokens ?? null,
      payload.tokensIn ?? null,
      payload.tokensOut ?? null,
      payload.costUsd ?? null,
      extrasJson,
    ],
  );
};

export const getStreamRunMetrics = async (
  runId: string,
): Promise<StreamRunMetricsRow | null> => {
  const { rows } = await query(
    `SELECT
        run_id,
        project_id,
        run_type,
        stage,
        status,
        error_code,
        error_message,
        connection_count,
        reconnect_attempts,
        sse_disconnects,
        last_connection_at,
        last_disconnection_at,
        last_heartbeat_at,
        last_event_at,
        last_event_type,
        fallback_count,
        last_fallback_at,
        last_fallback_reason,
        downshift_count,
        forced_pagination_count,
        cursor_retry_count,
        last_downshift_at,
        model,
        max_output_tokens,
        tokens_in,
        tokens_out,
        cost_usd,
        extras,
        created_at,
        updated_at
      FROM stream_run_metrics
      WHERE run_id = $1
      LIMIT 1`,
    [runId],
  );

  if (!rows.length) return null;
  const row = rows[0] as StreamRunMetricsRow;
  return row;
};
