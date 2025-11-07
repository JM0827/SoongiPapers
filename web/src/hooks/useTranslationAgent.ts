import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../services/api";
import type {
  ChatAction,
  JobSummary,
  OriginPrepSnapshot,
  TranslationRunSummary,
} from "../types/domain";
import { useWorkflowStore } from "../store/workflow.store";
import type {
  AgentRunState,
  AgentSubState,
  TranslationAgentState,
  TranslationStatus,
  TranslationAgentPageV2,
} from "../store/workflow.store";
import {
  getOriginPrepGuardMessage,
  isOriginPrepReady,
} from "../lib/originPrep";
import { dedupeAgentPages, normalizeAgentPageEvent } from "../lib/agentPage";
import type { TranslationStreamEvent } from "../services/api";
import { useCanonicalWarmup } from "./useCanonicalWarmup";

const V2_STAGE_ORDER = ["draft", "revise", "micro-check"] as const;

const STAGE_LABELS: Record<string, string> = {
  draft: "Draft 생성",
  revise: "정밀수정",
  "micro-check": "마이크로 검사",
  finalizing: "후처리",
};

const MAX_TRANSLATION_CURSOR_HISTORY = 96;
const MAX_STREAM_RECONNECT_ATTEMPTS = 10;

type CursorTask = {
  cursor: string;
  runId: string;
};

type StreamConnectionState = "idle" | "connecting" | "streaming" | "backoff";

const trimHistory = (values: string[], max: number): string[] =>
  values.length > max ? values.slice(values.length - max) : values;

const toStreamRecord = (
  value: TranslationStreamEvent["data"],
): Record<string, unknown> =>
  (value && typeof value === "object" ? value : {}) as Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTranslationRunSummaryPayload = (
  value: unknown,
): value is TranslationRunSummary => {
  if (!isRecord(value)) return false;
  if (typeof value.projectId !== "string") return false;
  if (!isRecord(value.translation) || !Array.isArray(value.translation.stages)) {
    return false;
  }
  if (!isRecord(value.progress) || !isRecord(value.progress.byStage)) {
    return false;
  }
  if (!isRecord(value.followups)) return false;
  if (typeof value.followups.needsFollowupTotal !== "number") return false;
  if (!isRecord(value.followups.byStage)) return false;
  return true;
};

const toStringOrNull = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const toBooleanOrNull = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

const normalizeStageStatus = (
  value: unknown,
): "queued" | "in_progress" | "done" | "error" => {
  if (
    value === "queued" ||
    value === "in_progress" ||
    value === "done" ||
    value === "error"
  ) {
    return value;
  }
  return "in_progress";
};

const deriveCursorForEnvelope = (
  envelope: TranslationAgentPageV2,
): string | null => {
  const stage =
    typeof envelope.tier === "string" && envelope.tier.trim().length
      ? envelope.tier.trim()
      : envelope.chunk_id.split(":")[0]?.trim() ?? null;
  if (!stage) return null;
  if (Array.isArray(envelope.segment_hashes)) {
    const hash = envelope.segment_hashes.find(
      (entry) => typeof entry === "string" && entry.trim().length > 0,
    );
    if (hash) {
      return `${stage}:${hash}`;
    }
  }

  // Legacy fallback: derive from chunk_id index
  const chunkParts = envelope.chunk_id.split(":");
  if (!chunkParts.length) return null;
  if (chunkParts.length <= 2) {
    return `${stage}:0`;
  }
  const indexPart = chunkParts[chunkParts.length - 1];
  const pageIndex = Number(indexPart);
  if (!Number.isFinite(pageIndex) || pageIndex < 0) {
    return `${stage}:0`;
  }
  return `${stage}:${Math.floor(pageIndex)}`;
};

const getStageLabelSequence = (pipelineStages: string[]) =>
  [...pipelineStages, "finalizing"]
    .map((stage) => STAGE_LABELS[stage] ?? stage)
    .join(" -> ");

const createRunState = (
  status: AgentRunState["status"],
  overrides?: Partial<AgentRunState>,
): AgentRunState => ({
  status,
  heartbeatAt: overrides?.heartbeatAt ?? Date.now(),
  willRetry: overrides?.willRetry ?? false,
  nextRetryDelayMs: overrides?.nextRetryDelayMs ?? null,
});

const extractWorkflowConflict = (
  payload: unknown,
): {
  reason: string | null;
  projectStatus: string | null;
} => {
  if (typeof payload === "string") {
    try {
      const parsed = JSON.parse(payload);
      return extractWorkflowConflict(parsed);
    } catch {
      return { reason: null, projectStatus: null };
    }
  }

  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const reason = typeof record.reason === "string" ? record.reason : null;
    const projectStatus =
      typeof record.projectStatus === "string" ? record.projectStatus : null;
    return { reason, projectStatus };
  }

  return { reason: null, projectStatus: null };
};

const deriveActiveTranslationJob = (jobs: JobSummary[]): JobSummary | null => {
  const preferredStatuses = new Set(["running", "queued", "pending"]);

  for (const job of jobs) {
    if (job.type !== "translate") continue;
    if (preferredStatuses.has(job.status)) {
      return job;
    }
  }

  return null;
};

type PushAssistant = (
  text: string,
  badge?:
    | {
        label: string;
        description?: string;
        tone?: "default" | "success" | "error";
      }
    | undefined,
  actions?: ChatAction[] | undefined,
  persist?: boolean,
) => void;

interface UseTranslationAgentParams {
  token: string | null;
  projectId: string | null;
  originText: string;
  targetLang: string | null | undefined;
  pushAssistant: PushAssistant;
  onCompleted?: () => void;
  refreshContent?: () => void;
  isTranslationReady?: () => boolean;
  lifecycle?: {
    stage: string | null;
    jobId?: string | null;
    batchesCompleted?: number | null;
    batchesTotal?: number | null;
    lastUpdatedAt?: string | null;
  };
  originPrep?: OriginPrepSnapshot | null;
  localize: (
    key: string,
    fallback: string,
    params?: Record<string, string | number>,
  ) => string;
}

export const useTranslationAgent = ({
  token,
  projectId,
  originText,
  targetLang,
  pushAssistant,
  onCompleted,
  refreshContent,
  isTranslationReady,
  lifecycle,
  originPrep,
  localize,
}: UseTranslationAgentParams) => {
  const translation = useWorkflowStore((state) => state.translation);
  const setTranslation = useWorkflowStore((state) => state.setTranslation);
  const resetTranslation = useWorkflowStore((state) => state.resetTranslation);
  useCanonicalWarmup({
    token,
    projectId,
    jobId: translation.jobId,
    cacheState: translation.canonicalCacheState ?? null,
  });
  const onCompletedRef = useRef(onCompleted ?? null);
  const completedNotifiedRef = useRef(false);
  const setTranslationForProject = useCallback(
    (
      update:
        | Partial<TranslationAgentState>
        | ((current: TranslationAgentState) => Partial<TranslationAgentState>),
    ) => {
      if (!projectId) return;
      setTranslation(projectId, update);
    },
    [projectId, setTranslation],
  );

  const [connectionState, setConnectionState] = useState<StreamConnectionState>(
    "idle",
  );
  const connectionStateRef = useRef<StreamConnectionState>("idle");
  const streamRef = useRef<(() => void) | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const pollingTimerRef = useRef<number | null>(null);
  const hydrationTokenRef = useRef<symbol | null>(null);
  const hydratedTokenRef = useRef<symbol | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectLimitReachedRef = useRef(false);
  const lastStageRef = useRef<string | null>(null);
  const finalizingRef = useRef(false);
  const finalizationTimeoutRef = useRef<number | null>(null);
  const originPrepRef = useRef<OriginPrepSnapshot | null>(originPrep ?? null);
  const streamJobIdRef = useRef<string | null>(null);
  const streamCompletedRef = useRef(false);
  const translationStatusRef = useRef<TranslationStatus>(translation.status);
  const cursorQueueRef = useRef<CursorTask[]>([]);
  const cursorProcessingRef = useRef(false);
  const handleStreamEventRef = useRef<
    (event: TranslationStreamEvent) => CursorTask | null
  >(() => null);
  const scheduleCursorDrainRef = useRef<() => void>(() => undefined);
  const startStreamRef = useRef<
    (jobId: string, options?: { hydrationToken?: symbol | null }) => void
  >(() => undefined);

  const triggerTranslationFallback = useCallback(() => {
    scheduleCursorDrainRef.current();
  }, []);

  useEffect(() => {
    originPrepRef.current = originPrep ?? null;
  }, [originPrep]);

  useEffect(() => {
    translationStatusRef.current = translation.status;
  }, [translation.status]);

  useEffect(() => {
    onCompletedRef.current = onCompleted ?? null;
  }, [onCompleted]);

  useEffect(() => {
    if (translation.status === "done") {
      if (!completedNotifiedRef.current) {
        completedNotifiedRef.current = true;
        onCompletedRef.current?.();
      }
    } else {
      completedNotifiedRef.current = false;
    }
  }, [translation.status]);

  const setConnectionStateSafe = useCallback(
    (next: StreamConnectionState) => {
      if (connectionStateRef.current === next) return;
      connectionStateRef.current = next;
      setConnectionState(next);
    },
    [],
  );

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const clearPollingTimer = useCallback(() => {
    if (pollingTimerRef.current !== null) {
      window.clearTimeout(pollingTimerRef.current);
      pollingTimerRef.current = null;
    }
  }, []);

  const stopStreamInternal = useCallback(
    (options?: { preserveState?: boolean }) => {
      if (streamRef.current) {
        streamRef.current();
      }
      streamRef.current = null;
      streamJobIdRef.current = null;
      hydrationTokenRef.current = null;
      if (!options?.preserveState) {
        hydratedTokenRef.current = null;
        reconnectAttemptRef.current = 0;
        setConnectionStateSafe("idle");
      }
      clearReconnectTimer();
      clearPollingTimer();
    },
    [clearPollingTimer, clearReconnectTimer, setConnectionStateSafe],
  );

  const markStreamHealthy = useCallback(() => {
    reconnectAttemptRef.current = 0;
    clearReconnectTimer();
    clearPollingTimer();
    setConnectionStateSafe("streaming");
  }, [clearPollingTimer, clearReconnectTimer, setConnectionStateSafe]);

  const applySummaryToState = useCallback(
    (summary: TranslationRunSummary) => {
      if (!projectId) return;

      const normalizeStage = (stage: string | null | undefined) =>
        stage === "microcheck"
          ? "micro-check"
          : stage === "micro-check"
            ? "micro-check"
            : stage ?? null;

      const normalizedStages = summary.translation.stages.map((stage) => {
        const key = normalizeStage(stage.stage);
        const status = stage.status === "error"
          ? "failed"
          : stage.status === "done"
            ? "done"
            : "running";
        return {
          id: key ?? stage.stage,
          status,
          label: key ?? stage.stage,
        } satisfies AgentSubState;
      });

      const stageCounts = Object.fromEntries(
        Object.entries(summary.progress.byStage).map(([key, value]) => [
          key === "microcheck" ? "micro-check" : key,
          value.segmentsDone,
        ]),
      );

      const runStatus: TranslationStatus =
        summary.runStatus === "error"
          ? "failed"
          : summary.runStatus === "done"
            ? "done"
            : summary.runStatus === "queued"
              ? "queued"
              : "running";

      const heartbeatAt = summary.streamMeta?.lastHeartbeatAt
        ? Date.parse(summary.streamMeta.lastHeartbeatAt)
        : Date.now();

      const reconnectAttempts = summary.resilience?.reconnectAttempts ?? 0;
      const reconnectLimitReached =
        summary.resilience?.reconnectLimitReached ?? false;
      const retryLimitMessage = localize(
        "translation_stream_retry_limit",
        "The translation stream disconnected repeatedly. Please retry.",
      );

      reconnectAttemptRef.current = reconnectAttempts;
      reconnectLimitReachedRef.current = reconnectLimitReached;
      if (reconnectLimitReached) {
        reconnectAttemptRef.current = Math.max(
          reconnectAttempts,
          MAX_STREAM_RECONNECT_ATTEMPTS + 1,
        );
        clearReconnectTimer();
        clearPollingTimer();
        setConnectionStateSafe("idle");
        stopStreamInternal({ preserveState: true });
      }

      if (reconnectLimitReached) {
        setConnectionStateSafe("idle");
      }

      const followupByReason = Object.entries(summary.followups.byReason ?? {})
        .reduce<Record<string, number>>((acc, [key, value]) => {
          if (typeof value === "number" && Number.isFinite(value)) {
            acc[key] = value;
          }
          return acc;
        }, {});

      const canonicalCacheState = summary.canonicalCacheState;

      setTranslationForProject((current) => ({
        status:
          reconnectLimitReached && runStatus === "running"
            ? "recovering"
            : runStatus,
        jobId: summary.jobId ?? current.jobId,
        progressCompleted: summary.progress.segmentsCompleted,
        progressTotal: summary.progress.segmentsTotal,
        stageCounts,
        completedStages: summary.translation.stages
          .filter((stage) => stage.status === "done")
          .map((stage) => normalizeStage(stage.stage) ?? stage.stage),
        currentStage: normalizeStage(summary.translation.currentStage),
        needsReviewCount: summary.followups.needsFollowupTotal,
        totalSegments: summary.progress.segmentsTotal,
        guardFailures: Object.keys(followupByReason).length
          ? followupByReason
          : current.guardFailures,
        pipelineStages: summary.translation.stages.map(
          (stage) => normalizeStage(stage.stage) ?? stage.stage,
        ),
        lastError: reconnectLimitReached
          ? retryLimitMessage
          : summary.errors.lastErrorMessage ?? current.lastError,
        lastMessage: reconnectLimitReached ? retryLimitMessage : current.lastMessage,
        updatedAt: summary.updatedAt ?? current.updatedAt,
        run: {
          status:
            reconnectLimitReached && runStatus === "running"
              ? "recovering"
              : runStatus,
          heartbeatAt,
          willRetry: reconnectLimitReached ? false : current.run.willRetry ?? false,
          nextRetryDelayMs: reconnectLimitReached
            ? null
            : current.run.nextRetryDelayMs ?? null,
        },
        subStates: normalizedStages,
        followupSummary: {
          total: summary.followups.needsFollowupTotal,
          byStage: Object.fromEntries(
            Object.entries(summary.followups.byStage).map(([key, value]) => [
              key === "microcheck" ? "micro-check" : key,
              value,
            ]),
          ),
          byReason: followupByReason,
        },
        canonicalCacheState,
      }));
    },
    [
      projectId,
      setTranslationForProject,
      localize,
      setConnectionStateSafe,
      clearReconnectTimer,
      clearPollingTimer,
      stopStreamInternal,
      MAX_STREAM_RECONNECT_ATTEMPTS,
    ],
  );

  const refreshSummary = useCallback(
    async (options?: {
      runId?: string | null;
      jobId?: string | null;
      force?: boolean;
      hydrationToken?: symbol | null;
    }) => {
      if (!token || !projectId) return null;
      if (!options?.force && connectionStateRef.current === "streaming") {
        return null;
      }
      try {
        const summary = await api.fetchTranslationSummary(token, projectId, {
          runId: options?.runId ?? null,
          jobId: options?.jobId ?? null,
        });
        if (summary) {
          applySummaryToState(summary);
          if (options?.hydrationToken) {
            hydratedTokenRef.current = options.hydrationToken;
          }
        }
        return summary;
      } catch (error) {
        console.warn("[translation] failed to fetch summary", error);
        return null;
      }
    },
    [token, projectId, applySummaryToState],
  );

  const scheduleBackoffReconnect = useCallback(
    (jobId: string | null) => {
      if (!jobId) return;
      if (reconnectLimitReachedRef.current) return;
      reconnectAttemptRef.current += 1;
      const attempt = reconnectAttemptRef.current;
      if (attempt > MAX_STREAM_RECONNECT_ATTEMPTS) {
        reconnectLimitReachedRef.current = true;
        clearReconnectTimer();
        clearPollingTimer();
        setConnectionStateSafe("idle");
        stopStreamInternal({ preserveState: true });
        return;
      }
      const delay = Math.min(1000 * 2 ** (attempt - 1), 30000);
      setConnectionStateSafe("backoff");
      clearReconnectTimer();
      clearPollingTimer();
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        if (reconnectLimitReachedRef.current) {
          return;
        }
        const token = Symbol("stream-retry");
        hydrationTokenRef.current = token;
        void (async () => {
          await refreshSummary({ jobId, hydrationToken: token });
          if (hydrationTokenRef.current !== token) {
            return;
          }
          if (reconnectLimitReachedRef.current) {
            return;
          }
          stopStreamInternal({ preserveState: true });
          setConnectionStateSafe("connecting");
          startStreamRef.current(jobId, { hydrationToken: token });
        })().catch((error) => {
          console.warn("[translation] reconnect attempt failed", error);
        });
      }, delay);

      if (attempt >= 3 && pollingTimerRef.current === null) {
        pollingTimerRef.current = window.setTimeout(() => {
          pollingTimerRef.current = null;
          if (reconnectLimitReachedRef.current) {
            return;
          }
          void refreshSummary({ jobId, force: true });
        }, Math.min(delay + 2000, 12000));
      }
    },
    [
      refreshSummary,
      setConnectionStateSafe,
      stopStreamInternal,
      clearReconnectTimer,
      clearPollingTimer,
      MAX_STREAM_RECONNECT_ATTEMPTS,
      reconnectLimitReachedRef,
    ],
  );

  const handleStreamEvent = useCallback(
    (event: TranslationStreamEvent): CursorTask | null => {
      if (!projectId) return null;

      const mapStageToSubState = (
        status: "queued" | "in_progress" | "done" | "error",
      ): AgentSubState["status"] => {
        switch (status) {
          case "done":
            return "done";
          case "error":
            return "failed";
          default:
            return "running";
        }
      };

      if (event.type === "summary") {
        if (isTranslationRunSummaryPayload(event.data)) {
          try {
            applySummaryToState(event.data);
          } catch (error) {
            console.warn("[translation] failed to apply summary", error);
          }
        } else {
          console.warn("[translation] ignored malformed summary", event.data);
        }
        return null;
      }

      if (event.type === "stage") {
        markStreamHealthy();
        const data = toStreamRecord(event.data);
        const stage = toStringOrNull(data.stage) ?? "unknown";
        const status = normalizeStageStatus(data.status);
        const label = toStringOrNull(data.label);
        const message = toStringOrNull(data.message);
        const displayLabel =
          label ?? STAGE_LABELS[stage] ?? stage;
        const stageMessage =
          message ??
          `${displayLabel} 단계가 ${
            status === "done"
              ? "완료되었습니다."
              : status === "error"
                ? "오류 상태입니다."
                : "진행 중입니다."
          }`;
        setTranslation(projectId, (current) => {
          const pipelineStages =
            current.pipelineStages.length > 0
              ? current.pipelineStages
              : Array.from(V2_STAGE_ORDER);
          const subStates = [...current.subStates];
          const index = subStates.findIndex((entry) => entry.id === stage);
          const nextSubState: AgentSubState = {
            id: stage,
            label: displayLabel,
            status: mapStageToSubState(status),
            error: status === "error" ? message ?? null : null,
          };
          if (index >= 0) {
            subStates[index] = { ...subStates[index], ...nextSubState };
          } else {
            subStates.push(nextSubState);
          }
          const stageIndex = pipelineStages.indexOf(stage);
          const progressCompleted =
            status === "done" && stageIndex !== -1
              ? Math.max(current.progressCompleted, stageIndex + 1)
              : current.progressCompleted;
          const progressTotal =
            pipelineStages.length || current.progressTotal ||
            V2_STAGE_ORDER.length;
          const nextStatus: TranslationStatus =
            status === "error"
              ? "recovering"
              : current.status === "idle" || current.status === "queued"
                ? "running"
                : current.status;
          const targetRunStatus =
            status === "error" ? "recovering" : nextStatus;
          const runOverrides = {
            willRetry: status === "error",
            nextRetryDelayMs: status === "error"
              ? current.run.nextRetryDelayMs
              : current.run.nextRetryDelayMs ?? null,
          };
          return {
            status: nextStatus,
            currentStage: stage,
            lastMessage: stageMessage,
            lastError:
              status === "error"
                ? message ?? current.lastError
                : current.lastError,
            subStates,
            pipelineStages,
            progressTotal,
            progressCompleted,
            run: createRunState(targetRunStatus, runOverrides),
          };
        });
        return null;
      }

      if (event.type === "items") {
        markStreamHealthy();
        const envelope = normalizeAgentPageEvent(event.data ?? null);
        if (!envelope) return null;
        const cursorForPage = deriveCursorForEnvelope(envelope);
        setTranslation(projectId, (current) => {
          const key = `${envelope.run_id}:${envelope.chunk_id}`;
          const nextPages = [...current.pages];
          const existingIndex = nextPages.findIndex(
            (page) => `${page.run_id}:${page.chunk_id}` === key,
          );
          if (existingIndex >= 0) {
            nextPages[existingIndex] = envelope;
          } else {
            nextPages.push(envelope);
          }
          const dedupedPages = dedupeAgentPages(nextPages);
          const nextRunStatus =
            current.run.status === "idle" ? "running" : current.run.status;
          const pending = new Set(current.pendingCursors ?? []);
          const processed = new Set(current.processedCursors ?? []);
          if (cursorForPage) {
            pending.delete(cursorForPage);
            processed.add(cursorForPage);
          }
          const pendingHistory = trimHistory(
            Array.from(pending),
            MAX_TRANSLATION_CURSOR_HISTORY,
          );
          const processedHistory = trimHistory(
            Array.from(processed),
            MAX_TRANSLATION_CURSOR_HISTORY,
          );
          return {
            status: current.status === "idle" ? "running" : current.status,
            pages: dedupedPages,
            lastEnvelope: envelope,
            lastMessage:
              current.lastMessage ?? "번역 결과가 수신되고 있습니다.",
            lastError: null,
            run: createRunState(nextRunStatus, {
              willRetry: envelope.has_more || pendingHistory.length > 0,
              nextRetryDelayMs: current.run.nextRetryDelayMs ?? null,
            }),
            pendingCursors: pendingHistory,
            processedCursors: processedHistory,
          };
        });
        const nextCursorValue =
          typeof envelope.next_cursor === "string" &&
          envelope.next_cursor.trim().length
            ? envelope.next_cursor.trim()
            : null;
        if (envelope.has_more && nextCursorValue) {
          return {
            cursor: nextCursorValue,
            runId: envelope.run_id,
          } satisfies CursorTask;
        }
        return null;
      }

      if (event.type === "progress") {
        markStreamHealthy();
        const data = toStreamRecord(event.data);
        const hasMore = toBooleanOrNull(data.has_more);
        setTranslation(projectId, (current) => {
          const nextStatus =
            current.run.status === "idle" ? "running" : current.run.status;
          const willRetry = hasMore ?? current.run.willRetry;
          return {
            run: createRunState(nextStatus, {
              willRetry,
              heartbeatAt: Date.now(),
              nextRetryDelayMs: current.run.nextRetryDelayMs ?? null,
            }),
          };
        });
        return null;
      }

      if (event.type === "complete") {
        streamCompletedRef.current = true;
        markStreamHealthy();
        setTranslation(projectId, (current) => ({
          status: "done",
          lastMessage: current.lastMessage ?? "번역이 완료되었습니다.",
          lastError: null,
          run: createRunState("done", {
            willRetry: false,
            nextRetryDelayMs: null,
          }),
          pendingCursors: [],
          processedCursors: trimHistory(
            current.processedCursors ?? [],
            MAX_TRANSLATION_CURSOR_HISTORY,
          ),
        }));
        return null;
      }

      if (event.type === "error") {
        const data = toStreamRecord(event.data);
        const message =
          toStringOrNull(data.message) ?? "번역 스트림에서 오류가 발생했습니다.";
        const retryable = toBooleanOrNull(data.retryable) ?? false;
        setTranslation(projectId, (current) => ({
          status: "failed",
          lastError: message,
          lastMessage: message,
          run: createRunState("failed", {
            willRetry: retryable,
            nextRetryDelayMs: current.run.nextRetryDelayMs ?? null,
          }),
        }));
        stopStreamInternal();
        triggerTranslationFallback();
        return null;
      }

      if (event.type === "end") {
        const data = toStreamRecord(event.data);
        const completed = toBooleanOrNull(data.completed) ?? false;
        streamCompletedRef.current = completed;
        const jobIdForReconnect = streamJobIdRef.current ?? translation.jobId ?? null;

        if (!completed) {
          stopStreamInternal({ preserveState: true });
          scheduleBackoffReconnect(jobIdForReconnect);
          triggerTranslationFallback();
        } else {
          markStreamHealthy();
          stopStreamInternal();
        }
        return null;
      }

      return null;
    },
    [
      projectId,
      setTranslation,
      applySummaryToState,
      markStreamHealthy,
      scheduleBackoffReconnect,
      stopStreamInternal,
      triggerTranslationFallback,
      translation.jobId,
    ],
  );

  handleStreamEventRef.current = handleStreamEvent;

  const scheduleCursorDrain = useCallback(() => {
    if (cursorProcessingRef.current) return;
    if (!token || !projectId) return;
    if (!cursorQueueRef.current.length) return;

    cursorProcessingRef.current = true;

    const drain = async () => {
      const queueTask = (task: CursorTask) => {
        if (!task.cursor || !task.runId) return;
        const alreadyQueued = cursorQueueRef.current.some(
          (entry) => entry.cursor === task.cursor,
        );
        if (!alreadyQueued) {
          cursorQueueRef.current.unshift(task);
        }
        setTranslation(projectId, (current) => {
          const processed = new Set(current.processedCursors ?? []);
          if (processed.has(task.cursor)) {
            return {};
          }
          const pending = new Set(current.pendingCursors ?? []);
          if (pending.has(task.cursor)) {
            return {};
          }
          pending.add(task.cursor);
          const pendingHistory = trimHistory(
            Array.from(pending),
            MAX_TRANSLATION_CURSOR_HISTORY,
          );
          return {
            pendingCursors: pendingHistory,
          };
        });
      };

      while (cursorQueueRef.current.length) {
        const task = cursorQueueRef.current.shift()!;
        try {
          const response = await api.fetchTranslationItems({
            token,
            projectId,
            runId: task.runId,
            cursor: task.cursor,
          });

          setTranslation(projectId, (current) => {
            const pending = (current.pendingCursors ?? []).filter(
              (value) => value !== task.cursor,
            );
            const processed = new Set(current.processedCursors ?? []);
            processed.add(task.cursor);
            const pendingHistory = trimHistory(
              pending,
              MAX_TRANSLATION_CURSOR_HISTORY,
            );
            const processedHistory = trimHistory(
              Array.from(processed),
              MAX_TRANSLATION_CURSOR_HISTORY,
            );
            return {
              pendingCursors: pendingHistory,
              processedCursors: processedHistory,
              run: createRunState(current.run.status, {
                willRetry:
                  (response.hasMore ?? false) || pendingHistory.length > 0,
                heartbeatAt: Date.now(),
                nextRetryDelayMs: current.run.nextRetryDelayMs ?? null,
              }),
              canonicalCacheState:
                response.canonicalCacheState ?? current.canonicalCacheState,
            };
          });

          for (const event of response.events ?? []) {
            const outcome = handleStreamEventRef.current(event);
            if (outcome) {
              queueTask(outcome);
            }
          }

          if (response.nextCursor) {
            queueTask({ cursor: response.nextCursor, runId: task.runId });
          }
        } catch (error) {
          console.warn("[translation] failed to load cursor", {
            cursor: task.cursor,
            error,
          });
          setTranslation(projectId, (current) => ({
            pendingCursors: (current.pendingCursors ?? []).filter(
              (value) => value !== task.cursor,
            ),
            processedCursors: current.processedCursors ?? [],
          }));
        }
      }

      cursorProcessingRef.current = false;
      if (cursorQueueRef.current.length) {
        scheduleCursorDrain();
      }
    };

    drain().catch((error) => {
      cursorProcessingRef.current = false;
      console.warn("[translation] cursor drain failed", error);
    });
  }, [projectId, setTranslation, token]);

  useEffect(() => {
    scheduleCursorDrainRef.current = scheduleCursorDrain;
  }, [scheduleCursorDrain]);

  scheduleCursorDrainRef.current = scheduleCursorDrain;

  const enqueueCursor = useCallback(
    (task: CursorTask, options?: { skipDrain?: boolean; prepend?: boolean }) => {
      if (!projectId) return;
      if (!task.cursor || !task.runId) return;

      const alreadyQueued = cursorQueueRef.current.some(
        (entry) => entry.cursor === task.cursor,
      );
      if (!alreadyQueued) {
        if (options?.prepend) {
          cursorQueueRef.current.unshift(task);
        } else {
          cursorQueueRef.current.push(task);
        }
      }

      setTranslation(projectId, (current) => {
        const processed = new Set(current.processedCursors ?? []);
        if (processed.has(task.cursor)) {
          return {};
        }
        const pending = new Set(current.pendingCursors ?? []);
        if (pending.has(task.cursor)) {
          return {};
        }
        pending.add(task.cursor);
        const pendingHistory = trimHistory(
          Array.from(pending),
          MAX_TRANSLATION_CURSOR_HISTORY,
        );
        return {
          pendingCursors: pendingHistory,
        };
      });

      if (!options?.skipDrain) {
        scheduleCursorDrain();
      }
    },
    [projectId, scheduleCursorDrain, setTranslation],
  );

  const startStream = useCallback(
    (jobId: string, options?: { hydrationToken?: symbol | null }) => {
      if (!token || !projectId) return;
      if (reconnectLimitReachedRef.current) return;
      const attemptToken = options?.hydrationToken ?? Symbol("stream-start");
      hydrationTokenRef.current = attemptToken;

      if (streamJobIdRef.current !== jobId) {
        reconnectAttemptRef.current = 0;
        hydratedTokenRef.current = null;
        reconnectLimitReachedRef.current = false;
      }

      setConnectionStateSafe("connecting");

      const ensureHydrated = async () => {
        if (hydratedTokenRef.current === attemptToken) return;
        await refreshSummary({ jobId, hydrationToken: attemptToken });
      };

      const openStream = async () => {
        try {
          await ensureHydrated();
        } catch (error) {
          console.warn("[translation] hydration failed before stream", error);
        }

        if (hydrationTokenRef.current !== attemptToken) {
          return;
        }

        if (streamRef.current) {
          streamRef.current();
        }

        let firstPayloadSeen = false;
        const unsubscribe = api.streamTranslation({
          token,
          projectId,
          jobId,
          onEvent: (event) => {
            if (hydrationTokenRef.current !== attemptToken) {
              return;
            }
            if (!firstPayloadSeen) {
              firstPayloadSeen = true;
              markStreamHealthy();
            }
            const outcome = handleStreamEventRef.current(event);
            if (outcome) {
              enqueueCursor(outcome, { skipDrain: true });
            }
          },
          onError: () => {
            if (hydrationTokenRef.current !== attemptToken) {
              return;
            }
            stopStreamInternal({ preserveState: true });
            scheduleBackoffReconnect(jobId);
            triggerTranslationFallback();
            void refreshSummary({ jobId });
          },
        });

        streamRef.current = () => {
          unsubscribe();
        };
        streamJobIdRef.current = jobId;
      };

      void openStream();
    },
    [
      token,
      projectId,
      refreshSummary,
      markStreamHealthy,
      stopStreamInternal,
      scheduleBackoffReconnect,
      triggerTranslationFallback,
      enqueueCursor,
    ],
  );

  startStreamRef.current = startStream;

  useEffect(() => {
    if (!token || !projectId) {
      stopStreamInternal();
      return;
    }

    const jobId = translation.jobId;
    if (!jobId) {
      stopStreamInternal();
      return;
    }

    if (
      streamJobIdRef.current === jobId &&
      (connectionStateRef.current === "connecting" ||
        connectionStateRef.current === "streaming")
    ) {
      return;
    }

    if (
      connectionStateRef.current === "backoff" &&
      reconnectTimerRef.current !== null
    ) {
      return;
    }

    if (reconnectLimitReachedRef.current) {
      return;
    }

    const tokenSymbol = Symbol("stream-init");
    hydrationTokenRef.current = tokenSymbol;
    startStream(jobId, { hydrationToken: tokenSymbol });

    return () => {
      stopStreamInternal();
    };
  }, [
    token,
    projectId,
    translation.jobId,
    startStream,
    stopStreamInternal,
  ]);

  useEffect(() => {
    // Reset translation state when project changes
    stopStreamInternal();
    resetTranslation(projectId ?? null);
    lastStageRef.current = null;
    finalizingRef.current = false;
    reconnectAttemptRef.current = 0;
    reconnectLimitReachedRef.current = false;
    if (finalizationTimeoutRef.current !== null) {
      window.clearTimeout(finalizationTimeoutRef.current);
      finalizationTimeoutRef.current = null;
    }
  }, [projectId, resetTranslation, stopStreamInternal]);

  useEffect(() => {
    if (!projectId) return;
    const status = translation.status;
    if (
      status === "done" ||
      status === "failed" ||
      status === "cancelled"
    ) {
      stopStreamInternal();
    }
  }, [projectId, translation.status, stopStreamInternal]);

  useEffect(() => () => {
    cursorQueueRef.current = [];
    cursorProcessingRef.current = false;
  }, []);

  const translationReadyFlag = isTranslationReady?.() ?? false;

  useEffect(() => {
    if (!lifecycle) return;
    const stage = lifecycle.stage?.toLowerCase() ?? null;
    const stageIncludes = (value: string) => Boolean(stage?.includes(value));
    const translationReady = translationReadyFlag;
    if (!stage && !translationReady) return;
    const hasJob = Boolean(lifecycle.jobId);

    if (!projectId) return;

    if (
      (stageIncludes("translate") || stage === "translating") &&
      hasJob &&
      translation.status === "idle"
    ) {
      setTranslation(projectId, {
        run: createRunState("running"),
        status: "running",
        jobId: lifecycle.jobId ?? translation.jobId,
        progressCompleted:
          lifecycle.batchesCompleted ?? translation.progressCompleted,
        progressTotal: lifecycle.batchesTotal ?? translation.progressTotal,
        lastMessage: "번역이 진행 중입니다.",
      });
    } else if (
      stageIncludes("fail") &&
      hasJob &&
      translation.status === "idle"
    ) {
      setTranslation(projectId, {
        run: createRunState("failed"),
        status: "failed",
        lastError: "이전 번역 작업이 실패했습니다.",
      });
    } else if (
      (stageIncludes("done") ||
        stageIncludes("complete") ||
        stage === "translated" ||
        (stageIncludes("final") && translationReady)) &&
      translation.status !== "done"
    ) {
      finalizingRef.current = false;
      lastStageRef.current = null;
      setTranslation(projectId, {
        run: createRunState("done"),
        status: "done",
        jobId: null,
        lastMessage:
          translation.needsReviewCount > 0
            ? "QA 점검이 필요한 항목이 있습니다."
            : "번역이 완료되었습니다.",
        lastError: null,
        progressCompleted:
          lifecycle.batchesCompleted ?? translation.progressCompleted,
        progressTotal: lifecycle.batchesTotal ?? translation.progressTotal,
        updatedAt:
          lifecycle.lastUpdatedAt ??
          translation.updatedAt ??
          new Date().toISOString(),
      });
    } else if (
      translationReady &&
      translation.status !== "done" &&
      !stageIncludes("fail")
    ) {
      setTranslation(projectId, {
        run: createRunState("done"),
        status: "done",
        jobId: lifecycle.jobId ?? translation.jobId,
        lastMessage:
          translation.needsReviewCount > 0
            ? "QA 점검이 필요한 항목이 있습니다."
            : "번역이 완료되었습니다.",
        lastError: null,
        progressCompleted:
          lifecycle.batchesCompleted ?? translation.progressCompleted,
        progressTotal: lifecycle.batchesTotal ?? translation.progressTotal,
        updatedAt:
          lifecycle.lastUpdatedAt ??
          translation.updatedAt ??
          new Date().toISOString(),
      });
    }
  }, [
    lifecycle,
    setTranslation,
    translation.jobId,
    translation.progressCompleted,
    translation.progressTotal,
    translation.status,
    translation.needsReviewCount,
    translation.updatedAt,
    projectId,
    translationReadyFlag,
  ]);

  const cancelTranslation = useCallback(
    async ({
      jobId,
      workflowRunId,
      reason,
    }: {
      jobId?: string;
      workflowRunId?: string | null;
      reason?: string | null;
    } = {}) => {
      if (!token || !projectId) {
        return;
      }

      const targetJobId = jobId ?? translation.jobId;
      if (!targetJobId) {
        return;
      }

      try {
        await api.cancelTranslation(token, projectId, {
          jobId: targetJobId,
          workflowRunId: workflowRunId ?? null,
          reason: reason ?? null,
        });

        setTranslation(projectId, {
          run: createRunState("cancelled"),
          status: "cancelled",
          jobId: null,
          lastMessage: "번역 작업이 중지되었습니다.",
          lastError: null,
          updatedAt: new Date().toISOString(),
          progressCompleted: 0,
          progressTotal: 0,
          stageCounts: {},
          completedStages: [],
          currentStage: null,
          needsReviewCount: 0,
          totalSegments: 0,
          guardFailures: {},
          flaggedSegments: [],
          pendingCursors: [],
          processedCursors: [],
        });

        pushAssistant(
          "진행 중이던 번역 작업을 중지했습니다.",
          {
            label: "Translation cancelled",
            tone: "default",
          },
          undefined,
          true,
        );

        if (finalizationTimeoutRef.current !== null) {
          window.clearTimeout(finalizationTimeoutRef.current);
          finalizationTimeoutRef.current = null;
        }
        finalizingRef.current = false;

        await refreshContent?.();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "번역 중지 요청이 실패했습니다.";
        pushAssistant(message, {
          label: "Cancel failed",
          tone: "error",
        });
      }
    },
    [
      token,
      projectId,
      translation.jobId,
      pushAssistant,
      setTranslation,
      refreshContent,
    ],
  );

  const startTranslation = useCallback(
    async (options?: {
      label?: string | null;
      allowParallel?: boolean;
      originPrep?: OriginPrepSnapshot | null;
    }) => {
      if (translation.status === "running" || translation.status === "queued") {
        pushAssistant("이미 번역 작업이 진행 중입니다.", {
          label: "Translation in progress",
          tone: "default",
        });
        return;
      }
      if (!token) {
        return;
      }
      if (!projectId) {
        return;
      }

      const resolvedOriginDocId =
        options?.originPrep?.upload.originFileId ??
        originPrepRef.current?.upload.originFileId ??
        null;
      const trimmedOriginDocId =
        typeof resolvedOriginDocId === "string" && resolvedOriginDocId.trim().length
          ? resolvedOriginDocId.trim()
          : null;
      const hasOriginText = originText.trim().length > 0;
      if (!trimmedOriginDocId && !hasOriginText) {
        pushAssistant(
          localize(
            "translation_origin_missing",
            "원문을 먼저 저장한 뒤 번역을 시작해 주세요.",
          ),
          {
            label: localize("origin_prep_guard_label", "Prep needed"),
            tone: "default",
          },
        );
        return;
      }

      const prepSnapshot = options?.originPrep ?? originPrepRef.current;
      if (!isOriginPrepReady(prepSnapshot)) {
        const guardMessage =
          getOriginPrepGuardMessage(prepSnapshot, localize) ??
          localize(
            "origin_prep_guard_generic",
            "Finish the manuscript prep steps before translating.",
          );
        pushAssistant(guardMessage, {
          label: localize("origin_prep_guard_label", "Prep needed"),
          tone: "default",
        });
        return;
      }

      finalizingRef.current = false;
      if (finalizationTimeoutRef.current !== null) {
        window.clearTimeout(finalizationTimeoutRef.current);
        finalizationTimeoutRef.current = null;
      }

      setTranslation(projectId, {
        run: createRunState("queued"),
        status: "queued",
        jobId: null,
        lastError: null,
        lastMessage: "번역 작업을 준비 중입니다...",
        progressCompleted: 0,
        progressTotal: 0,
        stageCounts: {},
        completedStages: [],
        currentStage: null,
        needsReviewCount: 0,
        totalSegments: 0,
        guardFailures: {},
        flaggedSegments: [],
        pages: [],
        lastEnvelope: null,
      });
      try {
        const translationPayload: Parameters<
          typeof api.startTranslation
        >[1] = {
          documentId: projectId,
          project_id: projectId,
          targetLang: targetLang ?? undefined,
          workflowLabel: options?.label ?? null,
          workflowAllowParallel: options?.allowParallel ?? false,
        };
        if (trimmedOriginDocId) {
          translationPayload.originDocumentId = trimmedOriginDocId;
        } else {
          translationPayload.originalText = originText;
        }

        const response = await api.startTranslation(token, translationPayload);
        const totalPassesRaw =
          typeof response.totalPasses === "number" && response.totalPasses > 0
            ? response.totalPasses
            : 0;
        const pipelineStagesForJob = Array.from(V2_STAGE_ORDER);
        const stageProgressTotal =
          totalPassesRaw > 0 ? totalPassesRaw : pipelineStagesForJob.length;
        const sequentialDetailedMessage = `번역 작업을 시작했습니다. ${getStageLabelSequence(pipelineStagesForJob)} 순서로 진행됩니다.`;

        setTranslation(projectId, {
          run: createRunState("queued"),
          status: "queued",
          jobId: response.jobId,
          lastMessage: sequentialDetailedMessage,
          progressCompleted: 0,
          progressTotal: stageProgressTotal,
          stageCounts: {},
          completedStages: [],
          currentStage: null,
          needsReviewCount: 0,
          totalSegments: 0,
          pipelineStages: pipelineStagesForJob,
          pages: [],
          lastEnvelope: null,
        });
        console.info("[translation] job started", response.jobId);
      } catch (err) {
        const fallbackMessage =
          err instanceof Error ? err.message : "Unknown error";

        if (projectId && err instanceof ApiError && err.status === 409) {
          const payload = err.payload as Record<string, unknown> | undefined;
          if (
            payload &&
            typeof payload === "object" &&
            payload.error === "translation_prereq_incomplete"
          ) {
            const prepFromServer =
              (payload.originPrep as OriginPrepSnapshot | undefined) ?? null;
            if (prepFromServer) {
              originPrepRef.current = prepFromServer;
            }
            const guardMessage =
              getOriginPrepGuardMessage(
                prepFromServer ?? originPrepRef.current,
                localize,
              ) ??
              localize(
                "origin_prep_guard_generic",
                "Finish the manuscript prep steps before translating.",
              );
            pushAssistant(guardMessage, {
              label: localize("origin_prep_guard_label", "Prep needed"),
              tone: "default",
            });
            await refreshContent?.();
            return;
          }

          const { reason, projectStatus } = extractWorkflowConflict(
            err.payload,
          );

          if (reason === "already_running") {
            let synced = false;

            if (token) {
              try {
                const jobs = await api.listJobs(token, {
                  projectId,
                  limit: 25,
                });
                const activeJob = deriveActiveTranslationJob(jobs);

                if (activeJob) {
                  const sequential = activeJob.sequential ?? null;
                  const completedStages = sequential?.completedStages ?? [];
                  const stageCounts = (sequential?.stageCounts ?? {}) as Record<string, number>;
                  const guardFailures = sequential?.guardFailures ?? {};
                  const flaggedSegments = sequential?.flaggedSegments ?? [];
                  const totalSegments = sequential?.totalSegments ?? 0;
                  const needsReviewCount = sequential?.needsReviewCount ?? 0;
                  const syncedPipelineStages = sequential?.pipelineStages
                    ?.length
                    ? sequential.pipelineStages
                    : Array.from(V2_STAGE_ORDER);
                  const progressTotal = syncedPipelineStages.length;
                  const progressCompleted = Math.min(
                    completedStages.length,
                    progressTotal,
                  );
                  const currentStage =
                    sequential?.currentStage ??
                    syncedPipelineStages[progressCompleted] ??
                    completedStages.at(-1) ??
                    null;

                setTranslation(projectId, {
                  run: createRunState(
                    activeJob.status === "running" ? "running" : "queued",
                  ),
                  status:
                    activeJob.status === "running" ? "running" : "queued",
                  jobId: activeJob.id,
                  lastError: null,
                  lastMessage: "이미 진행 중인 번역 작업을 불러왔습니다.",
                  progressCompleted,
                  progressTotal,
                  stageCounts,
                  completedStages,
                  currentStage,
                  needsReviewCount,
                  totalSegments,
                  guardFailures,
                  flaggedSegments,
                  pipelineStages: syncedPipelineStages,
                  updatedAt: new Date().toISOString(),
                  pages: [],
                  lastEnvelope: null,
                });
                  synced = true;
                }
              } catch (syncError) {
                console.warn(
                  "[translation] failed to sync active job after conflict",
                  syncError,
                );
              }
            }

            if (!synced) {
              resetTranslation(projectId);
            }

            pushAssistant(
              "이미 번역 작업이 진행 중입니다. 워크플로 상태를 확인해 주세요.",
              {
                label: "Translation in progress",
                tone: "default",
              },
              [
                {
                  type: "viewTranslationStatus",
                  reason: "Check translation status",
                },
              ],
              true,
            );
            return;
          }

          if (reason === "project_inactive") {
            resetTranslation(projectId);
            const inactiveMessage =
              projectStatus && projectStatus.toLowerCase() === "completed"
                ? "완료된 프로젝트에서는 새 번역을 시작할 수 없습니다."
                : "이 프로젝트에서는 새 번역을 시작할 수 없습니다.";
            pushAssistant(
              inactiveMessage,
              {
                label: "Translation blocked",
                description: fallbackMessage,
                tone: "error",
              },
              undefined,
              true,
            );
            return;
          }
        }

        setTranslation(projectId ?? null, {
          run: createRunState("failed"),
          status: "failed",
          jobId: null,
          lastError: fallbackMessage,
          lastMessage: "번역 작업을 시작하지 못했습니다.",
          progressCompleted: 0,
          progressTotal: 0,
          stageCounts: {},
          completedStages: [],
          currentStage: null,
          needsReviewCount: 0,
          totalSegments: 0,
          pages: [],
          lastEnvelope: null,
        });
        pushAssistant(
          "번역 작업을 시작하지 못했습니다.",
          {
            label: "Translation failed",
            description: fallbackMessage,
            tone: "error",
          },
          undefined,
          true,
        );
      }
    },
    [
      translation.status,
      token,
      projectId,
      originText,
      targetLang,
      pushAssistant,
      setTranslation,
      resetTranslation,
      refreshContent,
      localize,
    ],
  );

  const canStart = useMemo(
    () =>
      translation.status === "idle" ||
      translation.status === "failed" ||
      translation.status === "done" ||
      translation.status === "cancelled",
    [translation.status],
  );

  return {
    state: translation,
    connectionState,
    canStart,
    startTranslation,
    cancelTranslation,
  };
};
