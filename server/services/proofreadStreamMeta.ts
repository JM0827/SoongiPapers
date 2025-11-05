import { getStreamRunMetrics, upsertStreamRunMetrics } from "../db/streamRunMetrics";

export interface ProofreadStreamMeta {
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
}

interface InternalMeta {
  runId: string;
  projectId: string | null;
  connectionCount: number;
  lastConnectionAt: string | null;
  lastDisconnectionAt: string | null;
  lastHeartbeatAt: string | null;
  lastEventAt: string | null;
  lastEventType: string | null;
  fallbackCount: number;
  lastFallbackAt: string | null;
  lastFallbackReason: string | null;
}

const metaStore = new Map<string, InternalMeta>();
const persistTimers = new Map<string, NodeJS.Timeout>();

const PERSIST_DEBOUNCE_MS = 500;

const shouldPersist = () => process.env.DISABLE_STREAM_META_PERSIST !== "1";

const toIso = (date: Date): string => date.toISOString();

const toPublicMeta = (meta: InternalMeta): ProofreadStreamMeta => {
  const reconnectAttempts = Math.max(0, meta.connectionCount - 1);
  return {
    runId: meta.runId,
    projectId: meta.projectId ?? null,
    connectionCount: meta.connectionCount,
    reconnectAttempts,
    lastConnectionAt: meta.lastConnectionAt,
    lastDisconnectionAt: meta.lastDisconnectionAt,
    lastHeartbeatAt: meta.lastHeartbeatAt,
    lastEventAt: meta.lastEventAt,
    lastEventType: meta.lastEventType,
    fallbackCount: meta.fallbackCount,
    lastFallbackAt: meta.lastFallbackAt,
    lastFallbackReason: meta.lastFallbackReason,
  };
};

const schedulePersist = (meta: InternalMeta) => {
  if (!shouldPersist()) return;
  const existingTimer = persistTimers.get(meta.runId);
  if (existingTimer) return;
  const timer = setTimeout(() => {
    persistTimers.delete(meta.runId);
    void persistMeta(meta.runId);
  }, PERSIST_DEBOUNCE_MS);
  persistTimers.set(meta.runId, timer);
};

const persistMeta = async (runId: string): Promise<void> => {
  if (!shouldPersist()) return;
  const meta = metaStore.get(runId);
  if (!meta) return;
  try {
    await upsertStreamRunMetrics({
      runId: meta.runId,
      projectId: meta.projectId,
      runType: "proofread",
      connectionCount: meta.connectionCount,
      reconnectAttempts: Math.max(0, meta.connectionCount - 1),
      lastConnectionAt: meta.lastConnectionAt,
      lastDisconnectionAt: meta.lastDisconnectionAt,
      lastHeartbeatAt: meta.lastHeartbeatAt,
      lastEventAt: meta.lastEventAt,
      lastEventType: meta.lastEventType,
      fallbackCount: meta.fallbackCount,
      lastFallbackAt: meta.lastFallbackAt,
      lastFallbackReason: meta.lastFallbackReason,
    });
  } catch (error) {
    // eslint-disable-next-line no-console -- temporary observability until logging pipeline added
    console.warn("[ProofSSE] failed to persist stream metrics", {
      runId,
      error,
    });
  }
};

const ensureMeta = (runId: string, projectId: string | null): InternalMeta => {
  const existing = metaStore.get(runId);
  if (existing) {
    if (projectId && !existing.projectId) {
      existing.projectId = projectId;
    }
    return existing;
  }
  const created: InternalMeta = {
    runId,
    projectId,
    connectionCount: 0,
    lastConnectionAt: null,
    lastDisconnectionAt: null,
    lastHeartbeatAt: null,
    lastEventAt: null,
    lastEventType: null,
    fallbackCount: 0,
    lastFallbackAt: null,
    lastFallbackReason: null,
  };
  metaStore.set(runId, created);
  return created;
};

export const recordProofreadConnectionOpen = (params: {
  runId: string;
  projectId: string | null;
}): void => {
  const { runId, projectId } = params;
  if (!runId) return;
  const meta = ensureMeta(runId, projectId);
  meta.connectionCount += 1;
  meta.lastConnectionAt = toIso(new Date());
  schedulePersist(meta);
};

export const recordProofreadConnectionClose = (runId: string): void => {
  if (!runId) return;
  const meta = metaStore.get(runId);
  if (!meta) return;
  meta.lastDisconnectionAt = toIso(new Date());
  schedulePersist(meta);
};

export const recordProofreadHeartbeat = (params: {
  runId: string;
  projectId: string | null;
}): void => {
  const { runId, projectId } = params;
  if (!runId) return;
  const meta = ensureMeta(runId, projectId);
  meta.lastHeartbeatAt = toIso(new Date());
  schedulePersist(meta);
};

export const recordProofreadFallback = (params: {
  runId: string;
  projectId: string | null;
  reason: string;
}): void => {
  const { runId, projectId, reason } = params;
  if (!runId) return;
  const meta = ensureMeta(runId, projectId);
  meta.fallbackCount += 1;
  meta.lastFallbackAt = toIso(new Date());
  meta.lastFallbackReason = reason;
  schedulePersist(meta);
};

export const recordProofreadEvent = (params: {
  runId: string;
  projectId: string | null;
  type: string;
}): void => {
  const { runId, projectId, type } = params;
  if (!runId) return;
  const meta = ensureMeta(runId, projectId);
  meta.lastEventAt = toIso(new Date());
  meta.lastEventType = type;
  schedulePersist(meta);
};

export const getProofreadStreamMeta = (
  runId: string | null | undefined,
): ProofreadStreamMeta | null => {
  if (!runId) return null;
  const meta = metaStore.get(runId);
  if (!meta) return null;
  return toPublicMeta(meta);
};

export const fetchProofreadStreamMeta = async (
  runId: string | null | undefined,
): Promise<ProofreadStreamMeta | null> => {
  if (!runId) return null;
  const cached = metaStore.get(runId);
  if (cached) return toPublicMeta(cached);
  if (!shouldPersist()) {
    return null;
  }
  try {
    const row = await getStreamRunMetrics(runId);
    if (!row) return null;
    return {
      runId: row.run_id,
      projectId: row.project_id ?? null,
      connectionCount: row.connection_count,
      reconnectAttempts: row.reconnect_attempts,
      lastConnectionAt: row.last_connection_at?.toISOString() ?? null,
      lastDisconnectionAt: row.last_disconnection_at?.toISOString() ?? null,
      lastHeartbeatAt: row.last_heartbeat_at?.toISOString() ?? null,
      lastEventAt: row.last_event_at?.toISOString() ?? null,
      lastEventType: row.last_event_type ?? null,
      fallbackCount: row.fallback_count,
      lastFallbackAt: row.last_fallback_at?.toISOString() ?? null,
      lastFallbackReason: row.last_fallback_reason ?? null,
    };
  } catch (error) {
    // eslint-disable-next-line no-console -- temporary observability until logging pipeline added
    console.warn("[ProofSSE] failed to load stream metrics", {
      runId,
      error,
    });
    return null;
  }
};

export const flushProofreadStreamMeta = async (
  runId?: string,
): Promise<void> => {
  if (!runId) {
    await Promise.all(Array.from(metaStore.keys()).map((id) => persistMeta(id)));
    return;
  }
  await persistMeta(runId);
};

export const resetProofreadStreamMeta = (runId?: string): void => {
  if (runId) {
    metaStore.delete(runId);
    const timer = persistTimers.get(runId);
    if (timer) {
      clearTimeout(timer);
      persistTimers.delete(runId);
    }
    return;
  }
  metaStore.clear();
  persistTimers.forEach((timer) => clearTimeout(timer));
  persistTimers.clear();
};
