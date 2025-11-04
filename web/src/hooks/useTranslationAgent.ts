import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../services/api";
import type {
  ChatAction,
  JobSummary,
  OriginPrepSnapshot,
} from "../types/domain";
import { useWorkflowStore } from "../store/workflow.store";
import type {
  AgentRunState,
  AgentSubState,
  TranslationAgentState,
  TranslationStatus,
} from "../store/workflow.store";
import {
  getOriginPrepGuardMessage,
  isOriginPrepReady,
} from "../lib/originPrep";
import { dedupeAgentPages, normalizeAgentPageEvent } from "../lib/agentPage";
import type { TranslationStreamEvent } from "../services/api";

type TranslationAgentPatch = Partial<
  Omit<TranslationAgentState, "run">
> & { run?: Partial<AgentRunState> };

const V2_STAGE_ORDER = ["draft", "revise", "micro-check"] as const;

const STAGE_LABELS: Record<string, string> = {
  draft: "Draft 생성",
  revise: "정밀수정",
  "micro-check": "마이크로 검사",
  finalizing: "후처리",
};

const toStreamRecord = (
  value: TranslationStreamEvent["data"],
): Record<string, unknown> =>
  (value && typeof value === "object" ? value : {}) as Record<string, unknown>;

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

  const pollingRef = useRef(false);
  const lastStatusRef = useRef<string | null>(translation.status);
  const lastStageRef = useRef<string | null>(null);
  const finalizingRef = useRef(false);
  const finalizationTimeoutRef = useRef<number | null>(null);
  const pollingErrorShownRef = useRef(false);
  const originPrepRef = useRef<OriginPrepSnapshot | null>(originPrep ?? null);
  const [streamEpoch, setStreamEpoch] = useState(0);
  const streamAbortRef = useRef<(() => void) | null>(null);
  const streamJobIdRef = useRef<string | null>(null);
  const lastStreamJobIdRef = useRef<string | null>(null);
  const streamFailureCountRef = useRef(0);
  const streamCompletedRef = useRef(false);
  const streamRetryTimeoutRef = useRef<number | null>(null);
  const translationStatusRef = useRef<TranslationStatus>(translation.status);

  useEffect(() => {
    originPrepRef.current = originPrep ?? null;
  }, [originPrep]);

  useEffect(() => {
    translationStatusRef.current = translation.status;
  }, [translation.status]);

  const clearStreamRetryTimeout = useCallback(() => {
    if (streamRetryTimeoutRef.current !== null) {
      window.clearTimeout(streamRetryTimeoutRef.current);
      streamRetryTimeoutRef.current = null;
    }
  }, []);

  const cleanupStream = useCallback(() => {
    if (streamAbortRef.current) {
      streamAbortRef.current();
    }
    streamAbortRef.current = null;
    streamJobIdRef.current = null;
    streamCompletedRef.current = false;
    clearStreamRetryTimeout();
  }, [clearStreamRetryTimeout]);

  const scheduleStreamRetry = useCallback(
    (attempt: number) => {
      const clampedAttempt = Math.max(1, Math.min(attempt, 5));
      const delay = Math.min(clampedAttempt * 1000, 5000);
      clearStreamRetryTimeout();
      streamRetryTimeoutRef.current = window.setTimeout(() => {
        streamRetryTimeoutRef.current = null;
        setStreamEpoch((value) => value + 1);
      }, delay);
    },
    [clearStreamRetryTimeout, setStreamEpoch],
  );

  const handleStreamEvent = useCallback(
    (event: TranslationStreamEvent) => {
      if (!projectId) return;

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

      if (event.type === "stage") {
        streamFailureCountRef.current = 0;
        clearStreamRetryTimeout();
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
        return;
      }

      if (event.type === "items") {
        streamFailureCountRef.current = 0;
        clearStreamRetryTimeout();
        const envelope = normalizeAgentPageEvent(event.data ?? null);
        if (!envelope) return;
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
          return {
            status: current.status === "idle" ? "running" : current.status,
            pages: dedupedPages,
            lastEnvelope: envelope,
            lastMessage:
              current.lastMessage ?? "번역 결과가 수신되고 있습니다.",
            lastError: null,
            run: createRunState(nextRunStatus, {
              willRetry: envelope.has_more,
              nextRetryDelayMs: current.run.nextRetryDelayMs ?? null,
            }),
          };
        });
        return;
      }

      if (event.type === "progress") {
        streamFailureCountRef.current = 0;
        clearStreamRetryTimeout();
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
        return;
      }

      if (event.type === "complete") {
        streamCompletedRef.current = true;
        clearStreamRetryTimeout();
        setTranslation(projectId, (current) => ({
          status: "done",
          lastMessage: current.lastMessage ?? "번역이 완료되었습니다.",
          lastError: null,
          run: createRunState("done", {
            willRetry: false,
            nextRetryDelayMs: null,
          }),
        }));
        return;
      }

      if (event.type === "error") {
        clearStreamRetryTimeout();
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
        return;
      }

      if (event.type === "end") {
        streamAbortRef.current = null;
        streamJobIdRef.current = null;
        const data = toStreamRecord(event.data);
        const completed = toBooleanOrNull(data.completed) ?? false;
        streamCompletedRef.current = completed;
        clearStreamRetryTimeout();
        if (!completed) {
          if (
            translationStatusRef.current !== "failed" &&
            translationStatusRef.current !== "done" &&
            translationStatusRef.current !== "cancelled"
          ) {
            const nextAttempt = streamFailureCountRef.current + 1;
            streamFailureCountRef.current = nextAttempt;
            if (nextAttempt <= 5) {
              scheduleStreamRetry(nextAttempt);
            }
          }
        } else {
          streamFailureCountRef.current = 0;
        }
      }
    },
    [projectId, scheduleStreamRetry, setTranslation, clearStreamRetryTimeout],
  );

  useEffect(() => {
    if (!token || !projectId) {
      cleanupStream();
      streamFailureCountRef.current = 0;
      return;
    }

    const jobId = translation.jobId;
    const status = translation.status;

    if (
      !jobId ||
      status === "done" ||
      status === "failed" ||
      status === "cancelled"
    ) {
      cleanupStream();
      lastStreamJobIdRef.current = null;
      streamFailureCountRef.current = 0;
      return;
    }

    if (
      streamJobIdRef.current === jobId &&
      streamAbortRef.current !== null &&
      streamCompletedRef.current === false
    ) {
      return;
    }

    cleanupStream();
    streamCompletedRef.current = false;
    if (lastStreamJobIdRef.current !== jobId) {
      streamFailureCountRef.current = 0;
    }

    let cancelled = false;

    const unsubscribe = api.streamTranslation({
      token,
      projectId,
      jobId,
      onEvent: (event) => {
        if (cancelled) return;
        handleStreamEvent(event);
      },
      onError: () => {
        if (cancelled) return;
        streamAbortRef.current = null;
        streamJobIdRef.current = null;
        if (
          translationStatusRef.current !== "failed" &&
          translationStatusRef.current !== "done" &&
          translationStatusRef.current !== "cancelled"
        ) {
          const nextAttempt = streamFailureCountRef.current + 1;
          streamFailureCountRef.current = nextAttempt;
          if (nextAttempt <= 5) {
            scheduleStreamRetry(nextAttempt);
          }
        }
      },
    });

    streamAbortRef.current = unsubscribe;
    streamJobIdRef.current = jobId;
    lastStreamJobIdRef.current = jobId;

    return () => {
      cancelled = true;
      cleanupStream();
      lastStreamJobIdRef.current = null;
    };
  }, [
    token,
    projectId,
    translation.jobId,
    translation.status,
    streamEpoch,
    cleanupStream,
    handleStreamEvent,
    scheduleStreamRetry,
  ]);

  useEffect(() => {
    // Reset translation state when project changes
    lastStatusRef.current = "idle";
    resetTranslation(projectId ?? null);
    lastStageRef.current = null;
    finalizingRef.current = false;
    if (finalizationTimeoutRef.current !== null) {
      window.clearTimeout(finalizationTimeoutRef.current);
      finalizationTimeoutRef.current = null;
    }
  }, [projectId, resetTranslation]);

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

  const waitForTranslationResult = useCallback(async () => {
    if (!projectId) return false;
    const attempts = 3;
    for (let index = 0; index < attempts; index += 1) {
      await refreshContent?.();
      if (!isTranslationReady || isTranslationReady()) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    return Boolean(isTranslationReady ? isTranslationReady() : true);
  }, [projectId, refreshContent, isTranslationReady]);

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
      if (!originText.trim()) {
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
        const response = await api.startTranslation(token, {
          documentId: projectId,
          originalText: originText,
          targetLang: targetLang ?? undefined,
          project_id: projectId,
          workflowLabel: options?.label ?? null,
          workflowAllowParallel: options?.allowParallel ?? false,
        });
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

  useEffect(() => {
    const jobId = translation.jobId;
    if (!projectId || !jobId || !token || pollingRef.current) return;

    pollingRef.current = true;
    finalizingRef.current = false;
    let cancelled = false;
    let intervalId: number | null = null;

    const clearFinalizationTimer = () => {
      if (finalizationTimeoutRef.current !== null) {
        window.clearTimeout(finalizationTimeoutRef.current);
        finalizationTimeoutRef.current = null;
      }
    };

    const stopPolling = () => {
      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
      pollingRef.current = false;
    };

    clearFinalizationTimer();

    const poll = async () => {
      try {
        const job = await api.getJob(token, jobId);
        if (cancelled) return;
        if (!job) return;

        if (pollingErrorShownRef.current) {
          pollingErrorShownRef.current = false;
        }

        const currentTranslation = useWorkflowStore.getState().translation;

        const sequential = job.sequential ?? null;

        if (sequential) {
          const inferredPipelineStages = sequential.pipelineStages?.length
            ? sequential.pipelineStages
            : Array.from(V2_STAGE_ORDER);
          const totalStages = inferredPipelineStages.length;
          const stageCounts = (sequential.stageCounts ?? {}) as Record<string, number>;
          const completedStages = sequential.completedStages ?? [];
          const guardFailures = sequential.guardFailures ?? {};
          const flaggedSegments = sequential.flaggedSegments ?? [];
          const progressCompleted = Math.min(
            completedStages.length,
            totalStages,
          );
          const progressTotal = totalStages;
          const totalSegments = sequential.totalSegments ?? 0;
          const needsReviewCount = sequential.needsReviewCount ?? 0;

          const stageIndex = Math.min(progressCompleted, totalStages - 1);
          const inferredStage =
            sequential.currentStage ??
            inferredPipelineStages[stageIndex] ??
            null;
          const currentStage = inferredStage ?? null;
          const stageLabel = currentStage
            ? (STAGE_LABELS[currentStage] ?? currentStage)
            : null;

          const jobStatus =
            typeof job.status === "string" ? job.status : "unknown";
          lastStatusRef.current = jobStatus;

          const jobFailed = jobStatus === "failed";
          const jobCancelled = jobStatus === "cancelled";
          const jobDone =
            jobStatus === "done" ||
            jobStatus === "succeeded" ||
            progressCompleted >= totalStages;

          const nowIso = new Date().toISOString();

          const updateState = (patch: TranslationAgentPatch) =>
            setTranslation(projectId, (current) => {
              const nextJobId =
                patch.jobId !== undefined
                  ? patch.jobId
                  : patch.status === "done" ||
                      patch.status === "failed" ||
                      patch.status === "cancelled"
                    ? null
                    : (current.jobId ?? job.id);
              const nextStatus = (patch.status ??
                current.status) as AgentRunState["status"];
              const runOverrides = patch.run ?? {};
              const shouldRebuildRun =
                patch.run !== undefined || nextStatus !== current.run.status;
              const runState = shouldRebuildRun
                ? createRunState(runOverrides.status ?? nextStatus, {
                    ...runOverrides,
                    willRetry:
                      runOverrides.willRetry ?? current.run.willRetry ?? false,
                    nextRetryDelayMs:
                      runOverrides.nextRetryDelayMs ??
                      current.run.nextRetryDelayMs ??
                      null,
                  })
                : current.run;
              return {
                ...patch,
                stageCounts,
                completedStages,
                currentStage,
                needsReviewCount,
                totalSegments,
                guardFailures,
                flaggedSegments,
                pipelineStages: inferredPipelineStages,
                progressCompleted,
                progressTotal,
                updatedAt: nowIso,
                jobId: nextJobId,
                run: runState,
              };
            });

          if (jobFailed) {
            const failureMessage =
              (typeof job.last_error === "string" && job.last_error) ||
              "번역이 실패했습니다.";
            pushAssistant(failureMessage, {
              label: "Translation failed",
              tone: "error",
            });
            updateState({
              status: "failed",
              lastMessage: failureMessage,
              lastError: failureMessage,
              guardFailures,
              flaggedSegments,
              jobId: null,
            });
            lastStageRef.current = null;
            stopPolling();
            clearFinalizationTimer();
            finalizingRef.current = false;
            return;
          }

          if (jobCancelled) {
            pushAssistant("진행 중이던 번역 작업을 중지했습니다.", {
              label: "Translation cancelled",
              tone: "default",
            });
            updateState({
              status: "cancelled",
              lastMessage: "번역 작업이 중지되었습니다.",
              lastError: null,
              guardFailures,
              flaggedSegments,
              jobId: null,
            });
            lastStageRef.current = null;
            stopPolling();
            clearFinalizationTimer();
            finalizingRef.current = false;
            return;
          }

          if (jobDone) {
            if (finalizingRef.current) {
              return;
            }

            updateState({
              status: "running",
              lastMessage: "번역 결과를 정리하고 있습니다.",
              lastError: null,
              guardFailures,
              flaggedSegments,
              jobId: null,
            });
            lastStageRef.current = null;
            pushAssistant(
              "번역 결과를 정리하고 있습니다.",
              {
                label: "Translation finalizing",
                tone: "default",
              },
              undefined,
              true,
            );

            const finalize = async (attempt: number) => {
              if (cancelled) return;
              const ready = await waitForTranslationResult();
              if (cancelled) return;

              if (ready) {
                updateState({
                  status: "done",
                  jobId: null,
                  lastMessage: needsReviewCount
                    ? "QA 점검이 필요한 항목이 있습니다."
                    : "번역이 완료되었습니다.",
                  lastError: null,
                  guardFailures,
                  flaggedSegments,
                });
                pushAssistant(
                  needsReviewCount
                    ? "QA 점검이 필요한 항목이 있습니다."
                    : "번역이 완료되었습니다. 번역본을 확인해 주세요.",
                  {
                    label: needsReviewCount
                      ? "QA review pending"
                      : "Translation done",
                    tone: needsReviewCount ? "default" : "success",
                  },
                  [
                    {
                      type: "viewTranslatedText",
                      reason: "View translated text",
                    },
                  ],
                  true,
                );
                finalizingRef.current = false;
                onCompleted?.();
                clearFinalizationTimer();
                return;
              }

              updateState({
                status: "running",
                lastMessage:
                  "번역 결과를 불러오는 중입니다. 잠시 후 다시 확인해 주세요.",
                lastError: null,
                guardFailures,
                flaggedSegments,
                jobId: null,
              });

              if (attempt === 0) {
                pushAssistant(
                  "번역이 완료되었지만 결과를 정리하고 있습니다. 잠시 후 다시 확인해 주세요.",
                  {
                    label: "Translation pending refresh",
                    tone: "default",
                  },
                  undefined,
                  true,
                );
              }

              const nextDelay = Math.min(2000 * (attempt + 1), 10000);
              finalizationTimeoutRef.current = window.setTimeout(() => {
                void finalize(attempt + 1);
              }, nextDelay);
            };

            stopPolling();
            finalizingRef.current = true;
            clearFinalizationTimer();
            void finalize(0);
            return;
          }

          const message = stageLabel
            ? `${stageLabel} 진행 중${
                needsReviewCount > 0 && currentStage === "micro-check"
                  ? ` (검토 ${needsReviewCount}개)`
                  : ""
              }`
            : "번역 진행 중입니다.";

          const guardAlertCount = Object.entries(guardFailures)
            .filter(([key, count]) => key !== "allOk" && Number(count ?? 0) > 0)
            .reduce((acc, [, count]) => acc + Number(count ?? 0), 0);

          const extendedMessage =
            guardAlertCount > 0
              ? `${message} · 가드 점검 ${guardAlertCount}건`
              : message;

          updateState({
            status: "running",
            lastMessage: extendedMessage,
            lastError: null,
            guardFailures,
            flaggedSegments,
          });

          if (currentStage && lastStageRef.current !== currentStage) {
            lastStageRef.current = currentStage;
            pushAssistant(extendedMessage, {
              label: "Translation running",
              tone: "default",
            });
          }

          return;
        }

        const drafts = job.drafts ?? [];
        const completedPasses = drafts.filter(
          (draft) => draft.status === "succeeded",
        ).length;
        const failedDraft =
          drafts.find((draft) => draft.status === "failed") ?? null;
        const plannedPasses = drafts.length;
        const knownTotalPasses =
          plannedPasses || currentTranslation.progressTotal || 0;
        const runStatusMessage = (() => {
          if (
            job.status === "succeeded" ||
            completedPasses >= knownTotalPasses
          ) {
            return "번역이 완료되었습니다.";
          }
          if (job.status === "failed" || failedDraft) {
            return "번역이 실패했습니다.";
          }
          return "번역 진행 중입니다.";
        })();

        if (job.status !== lastStatusRef.current) {
          lastStatusRef.current =
            typeof job.status === "string" ? job.status : null;
          if (job.status === "running") {
            pushAssistant(
              runStatusMessage,
              {
                label: "Translation running",
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
            setTranslation(projectId, {
              run: createRunState("running"),
              status: "running",
              lastMessage: runStatusMessage,
              lastError: null,
            });
          } else if (job.status === "done") {
            if (finalizingRef.current) {
              return;
            }

            setTranslation(projectId, {
              run: createRunState("running"),
              status: "running",
              lastMessage: "번역 결과를 정리하고 있습니다.",
              lastError: null,
              jobId: null,
              progressCompleted: Math.max(completedPasses, knownTotalPasses),
              progressTotal: Math.max(knownTotalPasses, completedPasses),
            });
            pushAssistant(
              "번역 결과를 정리하고 있습니다.",
              {
                label: "Translation finalizing",
                tone: "default",
              },
              undefined,
              true,
            );

            const finalizeLegacy = async (attempt: number) => {
              if (cancelled) return;
              const ready = await waitForTranslationResult();
              if (cancelled) return;

              if (ready) {
                setTranslation(projectId, {
                  run: createRunState("done"),
                  status: "done",
                  lastMessage: "번역이 완료되었습니다.",
                  lastError: null,
                  jobId: null,
                  progressCompleted: Math.max(
                    completedPasses,
                    knownTotalPasses,
                  ),
                  progressTotal: Math.max(knownTotalPasses, completedPasses),
                });
                pushAssistant(
                  "번역이 완료되었습니다. 번역본을 확인하려면 클릭하세요.",
                  {
                    label: "Translation done",
                    tone: "success",
                  },
                  [
                    {
                      type: "viewTranslatedText",
                      reason: "View translated text",
                    },
                  ],
                  true,
                );
                finalizingRef.current = false;
                onCompleted?.();
                clearFinalizationTimer();
                return;
              }

              setTranslation(projectId, {
                run: createRunState("recovering", {
                  willRetry: true,
                  nextRetryDelayMs: Math.min(2000 * (attempt + 1), 10000),
                }),
                status: "running",
                lastMessage:
                  "번역 결과를 불러오는 중입니다. 잠시 후 다시 확인해 주세요.",
                lastError: null,
                jobId: null,
              });

              if (attempt === 0) {
                pushAssistant(
                  "번역이 완료되었지만 결과를 정리하고 있습니다. 잠시 후 다시 확인해 주세요.",
                  {
                    label: "Translation pending refresh",
                    tone: "default",
                  },
                  undefined,
                  true,
                );
              }

              const nextDelay = Math.min(2000 * (attempt + 1), 10000);
              finalizationTimeoutRef.current = window.setTimeout(() => {
                void finalizeLegacy(attempt + 1);
              }, nextDelay);
            };

            stopPolling();
            clearFinalizationTimer();
            finalizingRef.current = true;
            void finalizeLegacy(0);
            return;
          } else if (job.status === "failed") {
            const rawFailureMessage =
              failedDraft?.error ?? job?.last_error ?? "번역이 실패했습니다.";
            const failureMessage = rawFailureMessage.includes(
              "Draft response did not include any segments",
            )
              ? "번역 초안 생성이 실패했습니다. 다시 시도해 주세요."
              : rawFailureMessage;
            pushAssistant(
              failureMessage,
              {
                label: "Translation failed",
                tone: "error",
              },
              undefined,
              true,
            );
            setTranslation(projectId, {
              run: createRunState("failed"),
              status: "failed",
              lastMessage: failureMessage,
              lastError: failureMessage,
              jobId: null,
            });
            stopPolling();
            clearFinalizationTimer();
            finalizingRef.current = false;
            return;
          } else if (job.status === "cancelled") {
            pushAssistant(
              "진행 중이던 번역 작업을 중지했습니다.",
              {
                label: "Translation cancelled",
                tone: "default",
              },
              undefined,
              true,
            );
            setTranslation(projectId, {
              run: createRunState("cancelled"),
              status: "cancelled",
              lastMessage: "번역 작업이 중지되었습니다.",
              lastError: null,
              jobId: null,
            });
            stopPolling();
            clearFinalizationTimer();
            finalizingRef.current = false;
            return;
          }
        }

        setTranslation(projectId, (current) => {
          const inferredTotal =
            knownTotalPasses || current.progressTotal || drafts.length;
          const normalizedTotal = inferredTotal || completedPasses;
          return {
            progressCompleted: completedPasses,
            progressTotal: normalizedTotal,
            updatedAt: new Date().toISOString(),
            ...(job.status === "running"
              ? { lastMessage: runStatusMessage }
              : {}),
          };
        });
      } catch (err) {
        if (cancelled) return;

        const errorMessage =
          err instanceof Error ? err.message : "Unknown error";

        if (!pollingErrorShownRef.current) {
          console.warn("[translation] polling warning", errorMessage);
          pollingErrorShownRef.current = true;
        } else {
          console.warn("[translation] polling error", errorMessage);
        }

        setTranslation(projectId, (current) => ({
          ...current,
          lastError: errorMessage,
          updatedAt: new Date().toISOString(),
        }));

        return;
      }
    };

    intervalId = window.setInterval(poll, 4000);
    void poll();

    return () => {
      cancelled = true;
      stopPolling();
      clearFinalizationTimer();
      pollingErrorShownRef.current = false;
    };
  }, [
    translation.jobId,
    token,
    projectId,
    pushAssistant,
    setTranslation,
    onCompleted,
    refreshContent,
    waitForTranslationResult,
  ]);

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
    canStart,
    startTranslation,
    cancelTranslation,
  };
};
