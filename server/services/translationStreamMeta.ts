import {
  getStreamRunMetrics,
  type StreamRunMetricsRow,
  upsertStreamRunMetrics,
} from "../db/streamRunMetrics";

export interface TranslationStreamMeta {
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

const toPublicMeta = (meta: InternalMeta): TranslationStreamMeta => {
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
      runType: "translate",
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
    // eslint-disable-next-line no-console -- temporary visibility until pipeline logging established
    console.warn("[TranslationSSE] failed to persist stream metrics", {
      runId,
      error,
    });
  }
};

const ensureMeta = (
  runId: string,
  projectId: string | null,
): InternalMeta => {
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

export const recordTranslationConnectionOpen = (params: {
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

export const recordTranslationConnectionClose = (runId: string): void => {
  if (!runId) return;
  const meta = metaStore.get(runId);
  if (!meta) return;
  meta.lastDisconnectionAt = toIso(new Date());
  schedulePersist(meta);
};

export const recordTranslationHeartbeat = (params: {
  runId: string;
  projectId: string | null;
}): void => {
  const { runId, projectId } = params;
  if (!runId) return;
  const meta = ensureMeta(runId, projectId);
  meta.lastHeartbeatAt = toIso(new Date());
  schedulePersist(meta);
};

export const recordTranslationFallback = (params: {
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

export const recordTranslationEvent = (params: {
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

export const flushTranslationStreamMeta = async (
  runId?: string,
): Promise<void> => {
  if (!runId) {
    await Promise.all(Array.from(metaStore.keys()).map((id) => persistMeta(id)));
    return;
  }
  await persistMeta(runId);
};

export const resetTranslationStreamMeta = (runId?: string): void => {
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

export const getTranslationStreamMeta = (
  runId: string | null | undefined,
): TranslationStreamMeta | null => {
  if (!runId) return null;
  const meta = metaStore.get(runId);
  if (!meta) return null;
  return toPublicMeta(meta);
};

export const fetchTranslationStreamMeta = async (
  runId: string | null | undefined,
): Promise<TranslationStreamMeta | null> => {
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
    // eslint-disable-next-line no-console -- temporary visibility until pipeline logging established
    console.warn("[TranslationSSE] failed to load stream metrics", {
      runId,
      error,
    });
    return null;
  }
};

export interface TranslationMetricsSnapshot {
  runId: string;
  projectId: string | null;
  status?: "running" | "done" | "error";
  errorCode?: string | null;
  errorMessage?: string | null;
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

export interface RecordTranslationMetricsOptions {
  mergeExtras?: boolean;
  existing?: StreamRunMetricsRow | null;
}

const toNumberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return null;
    return value;
  }
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
};

const cloneExtras = (extras: Record<string, unknown> | null | undefined) => {
  if (!extras) return {} as Record<string, unknown>;
  try {
    return JSON.parse(JSON.stringify(extras)) as Record<string, unknown>;
  } catch (_error) {
    return { ...extras };
  }
};

export const recordTranslationMetricsSnapshot = async (
  snapshot: TranslationMetricsSnapshot,
  options?: RecordTranslationMetricsOptions,
): Promise<void> => {
  if (!snapshot.runId) return;
  try {
    const existing = options?.existing ?? (await getStreamRunMetrics(snapshot.runId));

    const mergedExtras = (() => {
      const base = cloneExtras(existing?.extras ?? {});
      if (!snapshot.extras) return options?.mergeExtras === false ? {} : base;
      if (options?.mergeExtras === false) {
        return cloneExtras(snapshot.extras);
      }
      return {
        ...base,
        ...snapshot.extras,
      };
    })();

    await upsertStreamRunMetrics({
      runId: snapshot.runId,
      projectId: snapshot.projectId ?? existing?.project_id ?? null,
      runType: existing?.run_type ?? "translate",
      stage: existing?.stage ?? null,
      status: snapshot.status ?? existing?.status ?? null,
      errorCode: snapshot.errorCode ?? existing?.error_code ?? null,
      errorMessage: snapshot.errorMessage ?? existing?.error_message ?? null,
      connectionCount: existing?.connection_count ?? 0,
      reconnectAttempts: existing?.reconnect_attempts ?? 0,
      sseDisconnects: existing?.sse_disconnects ?? 0,
      lastConnectionAt: existing?.last_connection_at?.toISOString() ?? null,
      lastDisconnectionAt: existing?.last_disconnection_at?.toISOString() ?? null,
      lastHeartbeatAt: existing?.last_heartbeat_at?.toISOString() ?? null,
      lastEventAt: existing?.last_event_at?.toISOString() ?? null,
      lastEventType: existing?.last_event_type ?? null,
      fallbackCount: existing?.fallback_count ?? 0,
      lastFallbackAt: existing?.last_fallback_at?.toISOString() ?? null,
      lastFallbackReason: existing?.last_fallback_reason ?? null,
      downshiftCount:
        snapshot.downshiftCount ?? existing?.downshift_count ?? 0,
      forcedPaginationCount:
        snapshot.forcedPaginationCount ?? existing?.forced_pagination_count ?? 0,
      cursorRetryCount:
        snapshot.cursorRetryCount ?? existing?.cursor_retry_count ?? 0,
      lastDownshiftAt:
        snapshot.lastDownshiftAt ?? existing?.last_downshift_at?.toISOString() ?? null,
      model: snapshot.model ?? existing?.model ?? null,
      maxOutputTokens:
        snapshot.maxOutputTokens ?? existing?.max_output_tokens ?? null,
      tokensIn:
        snapshot.tokensIn ?? toNumberOrNull(existing?.tokens_in) ?? null,
      tokensOut:
        snapshot.tokensOut ?? toNumberOrNull(existing?.tokens_out) ?? null,
      costUsd:
        snapshot.costUsd ?? toNumberOrNull(existing?.cost_usd) ?? null,
      extras: mergedExtras,
    });
  } catch (error) {
    // eslint-disable-next-line no-console -- temporary visibility until pipeline logging established
    console.warn("[TranslationSSE] failed to persist metrics snapshot", {
      runId: snapshot.runId,
      error,
    });
  }
};
