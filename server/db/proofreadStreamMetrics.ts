import { query } from "../db";

export interface ProofreadStreamMetricsRow {
  run_id: string;
  project_id: string | null;
  connection_count: number;
  reconnect_attempts: number;
  last_connection_at: Date | null;
  last_disconnection_at: Date | null;
  last_heartbeat_at: Date | null;
  last_event_at: Date | null;
  last_event_type: string | null;
  fallback_count: number;
  last_fallback_at: Date | null;
  last_fallback_reason: string | null;
  updated_at: Date;
}

export const upsertProofreadStreamMetrics = async (payload: {
  runId: string;
  projectId: string | null;
  connectionCount: number;
  reconnectAttempts: number;
  lastConnectionAt: string | null;
  lastDisconnectionAt: string | null;
  lastHeartbeatAt: string | null;
  lastEventAt: string | null;
  lastEventType: string | null;
  fallbackCount: number;
  lastFallbackAt: string | null;
  lastFallbackReason: string | null;
}): Promise<void> => {
  const {
    runId,
    projectId,
    connectionCount,
    reconnectAttempts,
    lastConnectionAt,
    lastDisconnectionAt,
    lastHeartbeatAt,
    lastEventAt,
    lastEventType,
    fallbackCount,
    lastFallbackAt,
    lastFallbackReason,
  } = payload;

  await query(
    `INSERT INTO proofread_stream_metrics (
        run_id,
        project_id,
        connection_count,
        reconnect_attempts,
        last_connection_at,
        last_disconnection_at,
        last_heartbeat_at,
        last_event_at,
        last_event_type,
        fallback_count,
        last_fallback_at,
        last_fallback_reason,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW()
      )
      ON CONFLICT (run_id) DO UPDATE SET
        project_id = EXCLUDED.project_id,
        connection_count = EXCLUDED.connection_count,
        reconnect_attempts = EXCLUDED.reconnect_attempts,
        last_connection_at = EXCLUDED.last_connection_at,
        last_disconnection_at = EXCLUDED.last_disconnection_at,
        last_heartbeat_at = EXCLUDED.last_heartbeat_at,
        last_event_at = EXCLUDED.last_event_at,
        last_event_type = EXCLUDED.last_event_type,
        fallback_count = EXCLUDED.fallback_count,
        last_fallback_at = EXCLUDED.last_fallback_at,
        last_fallback_reason = EXCLUDED.last_fallback_reason,
        updated_at = NOW()`,
    [
      runId,
      projectId,
      connectionCount,
      reconnectAttempts,
      lastConnectionAt,
      lastDisconnectionAt,
      lastHeartbeatAt,
      lastEventAt,
      lastEventType,
      fallbackCount,
      lastFallbackAt,
      lastFallbackReason,
    ],
  );
};

export const getProofreadStreamMetrics = async (
  runId: string,
): Promise<ProofreadStreamMetricsRow | null> => {
  const { rows } = await query(
    `SELECT
        run_id,
        project_id,
        connection_count,
        reconnect_attempts,
        last_connection_at,
        last_disconnection_at,
        last_heartbeat_at,
        last_event_at,
        last_event_type,
        fallback_count,
        last_fallback_at,
        last_fallback_reason,
        updated_at
      FROM proofread_stream_metrics
      WHERE run_id = $1
      LIMIT 1`,
    [runId],
  );

  if (!rows.length) return null;
  const row = rows[0] as ProofreadStreamMetricsRow;
  return row;
};
