import { useCallback, useEffect, useMemo } from "react";
import { api } from "../services/api";
import type { ChatAction } from "../types/domain";
import { useWorkflowStore } from "../store/workflow.store";
import type {
  AgentRunState,
  AgentSubState,
  ProofreadingAgentState,
} from "../store/workflow.store";
import { useProofreadCommandStore } from "../store/proofreadCommand.store";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

interface UseProofreadAgentParams {
  token: string | null;
  projectId: string | null;
  translationJobId: string | null;
  hasTranslation: boolean;
  pushAssistant: PushAssistant;
  onCompleted?: () => void;
  refreshContent?: () => void;
  openProofreadTab?: () => void;
  lifecycle?: {
    stage: string | null;
    jobId?: string | null;
    lastUpdatedAt?: string | null;
  };
}

const DEFAULT_STALL_THRESHOLD_MS = (() => {
  const raw =
    import.meta.env.VITE_PROOFREAD_HEARTBEAT_MS ??
    import.meta.env.VITE_PROOFREAD_STALL_MS ??
    "60000";
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60000;
})();

const createRunState = (
  status: AgentRunState["status"],
  overrides?: Partial<AgentRunState>,
): AgentRunState => ({
  status,
  heartbeatAt: overrides?.heartbeatAt ?? Date.now(),
  willRetry: overrides?.willRetry ?? false,
  nextRetryDelayMs: overrides?.nextRetryDelayMs ?? null,
});

const mapStageStatusesToSubStates = (
  stages: Array<{
    tier?: string | null;
    key?: string | null;
    label?: string | null;
    status?: string | null;
  }>,
): AgentSubState[] =>
  stages.map((stage, index) => {
    const id = `${stage.tier ?? "global"}:${stage.key ?? stage.label ?? index}`;
    const normalized = (stage.status ?? "").toLowerCase();
    const status: AgentSubState["status"] =
      normalized === "done"
        ? "done"
        : normalized === "error"
          ? "failed"
          : "running";
    return {
      id,
      status,
      label: stage.label ?? stage.key ?? stage.tier ?? id,
    };
  });

export const useProofreadAgent = ({
  token,
  projectId,
  translationJobId,
  hasTranslation,
  pushAssistant,
  onCompleted,
  refreshContent,
  openProofreadTab,
  lifecycle,
}: UseProofreadAgentParams) => {
  const proofreading = useWorkflowStore((state) => state.proofreading);
  const setProofreading = useWorkflowStore((state) => state.setProofreading);
  const resetProofreading = useWorkflowStore(
    (state) => state.resetProofreading,
  );

  const setProofreadingForProject = useCallback(
    (
      update:
        | Partial<ProofreadingAgentState>
        | ((
            current: ProofreadingAgentState,
          ) => Partial<ProofreadingAgentState>),
    ) => {
      if (!projectId) return;
      setProofreading(projectId, update);
    },
    [projectId, setProofreading],
  );

  const appendActivity = useCallback(
    (
      type: string,
      message: string,
      meta?: Record<string, unknown> | null,
      options?: { updateHeartbeat?: boolean },
    ) => {
      const timestamp = new Date().toISOString();
      const id = `${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      setProofreadingForProject((current) => {
        const existing = current.activityLog ?? [];
        const next = existing.slice(-49);
        next.push({ id, timestamp, type, message, meta: meta ?? null });
        return {
          activityLog: next,
          ...(options?.updateHeartbeat === false
            ? {}
            : {
                lastHeartbeatAt: timestamp,
                isStalled: false,
              }),
        };
      });
    },
    [setProofreadingForProject],
  );

  useEffect(() => {
    resetProofreading(projectId ?? null);
  }, [projectId, resetProofreading]);

  useEffect(() => {
    if (!lifecycle || !projectId) return;
    const stageRaw = lifecycle.stage;
    if (!stageRaw) return;

    const stage = stageRaw.toLowerCase();
    const normalized = stage.replace(/\s+/g, "");

    const detectStageStatus = (): ProofreadingAgentState["status"] | null => {
      if (/fail|error|cancel/.test(normalized)) return "failed";
      if (/run|progress|working/.test(normalized)) return "running";
      if (/queue|pend|wait/.test(normalized)) return "queued";
      if (/done|complete|finish|success/.test(normalized)) return "done";
      return null;
    };

    const nextStatus = detectStageStatus();
    if (!nextStatus) return;

    setProofreadingForProject((current) => {
      const nextProofreadingId = lifecycle.jobId ?? current.proofreadingId;
      if (
        current.status === nextStatus &&
        current.proofreadingId === nextProofreadingId
      ) {
        return current;
      }

      return {
        ...current,
        status: nextStatus,
        proofreadingId: nextProofreadingId,
        lastError: nextStatus === "failed" ? current.lastError : null,
        lastMessage:
          nextStatus === "running"
            ? (current.lastMessage ?? "교정이 진행 중입니다.")
            : nextStatus === "queued"
              ? (current.lastMessage ?? "교정 작업이 대기 중입니다.")
              : nextStatus === "done"
                ? (current.lastMessage ?? "교정이 완료되었습니다.")
                : nextStatus === "failed"
                  ? (current.lastMessage ?? "최근 교정이 실패했습니다.")
                  : current.lastMessage,
        run: createRunState(nextStatus),
        subStates: mapStageStatusesToSubStates(current.stageStatuses ?? []),
      };
    });
  }, [lifecycle, projectId, setProofreadingForProject]);

  const startProofread = useCallback(
    async (options?: {
      label?: string | null;
      allowParallel?: boolean;
      runDeep?: boolean;
    }) => {
      if (
        proofreading.status === "running" ||
        proofreading.status === "queued"
      ) {
        pushAssistant("이미 교정 작업이 진행 중입니다.", {
          label: "Proofread in progress",
          tone: "default",
        });
        return;
      }
      if (!token || !projectId) {
        return;
      }
      if (!translationJobId || !hasTranslation) {
        return;
      }

      setProofreadingForProject(() => ({
        status: "queued",
        lastError: null,
        lastMessage: "교정 작업을 준비 중입니다.",
        proofreadingId: null,
        stageStatuses: [],
        subStates: [],
        tierSummaries: {},
        completionSummary: null,
        lastHeartbeatAt: new Date().toISOString(),
        isStalled: false,
        run: createRunState("queued"),
      }));
      appendActivity("queued", "교정 작업을 준비 중입니다.");
      pushAssistant(
        "교정 작업을 시작합니다.",
        { label: "Proofread queued", tone: "default" },
        undefined,
        true,
      );

      let completed = false;
      let encounteredError = false;
      let skippedBecauseDuplicate = false;
      try {
        await api.requestProofreading(token, projectId, translationJobId, {
          label: options?.label ?? null,
          allowParallel: options?.allowParallel ?? false,
          runDeep: options?.runDeep ?? false,
          onEvent: (event) => {
            const eventType = typeof event.type === "string" ? event.type : "";

            if (eventType === "progress") {
              const rawMessage =
                typeof event.message === "string" ? event.message : undefined;
              const progressMessage = rawMessage?.trim().length
                ? rawMessage
                : "교정 작업이 진행 중입니다.";
              setProofreadingForProject((current) => ({
                status: "running",
                lastMessage: progressMessage,
                lastError: null,
                lastHeartbeatAt: new Date().toISOString(),
                isStalled: false,
                run: createRunState("running"),
                subStates: mapStageStatusesToSubStates(
                  current.stageStatuses ?? [],
                ),
              }));
              appendActivity("progress", progressMessage);
              return;
            }

            if (eventType === "workflow") {
              const runStatus =
                typeof event.status === "string" ? event.status : "unknown";
              const runId =
                typeof event.runId === "string" ? event.runId : undefined;
              const label =
                typeof event.label === "string" ? event.label : undefined;
              appendActivity("workflow", "워크플로우 응답", {
                status: runStatus,
                runId,
                label,
              });
              if (runStatus !== "accepted") {
                pushAssistant("교정 워크플로우 요청이 거절되었습니다.", {
                  label: "Proofread workflow",
                  tone: "error",
                });
              }

              if (runStatus !== "accepted") {
                encounteredError = true;
                setProofreadingForProject((current) => ({
                  ...current,
                  status: "failed",
                  lastError:
                    typeof event.message === "string"
                      ? event.message
                      : "프로젝트 상태 때문에 교정 작업을 시작할 수 없습니다.",
                  lastMessage: "교정 워크플로우 요청이 거절되었습니다.",
                  run: createRunState("failed"),
                  subStates: mapStageStatusesToSubStates(
                    current.stageStatuses ?? [],
                  ),
                }));
              }

              return;
            }

            if (eventType === "stage") {
              const tier = typeof event.tier === "string" ? event.tier : null;
              const key = typeof event.key === "string" ? event.key : null;
              const label =
                typeof event.label === "string"
                  ? event.label
                  : (key ?? tier ?? "단계");
              const statusRaw =
                typeof event.status === "string" ? event.status : "in_progress";
              const stageMessage = `${label} (${
                statusRaw === "done"
                  ? "완료"
                  : statusRaw === "error"
                    ? "오류"
                    : "진행 중"
              })`;

              setProofreadingForProject((current) => {
                const nextStages = [...(current.stageStatuses ?? [])];
                const identifier = `${tier ?? ""}:${key ?? label}`;
                const index = nextStages.findIndex(
                  (entry) =>
                    `${entry.tier ?? ""}:${entry.key ?? entry.label ?? ""}` ===
                    identifier,
                );
                const updateEntry = {
                  tier,
                  key,
                  label,
                  status: statusRaw,
                };
                if (index >= 0) {
                  nextStages[index] = { ...nextStages[index], ...updateEntry };
                } else {
                  nextStages.push(updateEntry);
                }
                return {
                  status: "running",
                  lastMessage: stageMessage,
                  lastError: null,
                  stageStatuses: nextStages,
                  lastHeartbeatAt: new Date().toISOString(),
                  isStalled: false,
                  run: createRunState(
                    statusRaw === "error" ? "recovering" : "running",
                    {
                      willRetry: statusRaw === "error",
                    },
                  ),
                  subStates: mapStageStatusesToSubStates(nextStages),
                };
              });
              appendActivity("stage", stageMessage, {
                tier,
                key,
                status: statusRaw,
              });
              return;
            }

            if (eventType === "duplicate") {
              const status =
                typeof event.status === "string" ? event.status : "completed";
              const proofreadRunId =
                typeof event.proofread_run_id === "string"
                  ? event.proofread_run_id
                  : undefined;
              const message =
                status === "running"
                  ? "같은 번역본에 대한 교정이 이미 진행 중입니다. 잠시 후 결과를 확인해 주세요."
                  : "같은 번역본에 대한 교정 결과가 이미 존재합니다.";

              setProofreadingForProject((current) => {
                const nextStages =
                  status === "running"
                    ? (current.stageStatuses ?? [])
                    : (current.stageStatuses ?? []).map((entry) => ({
                        ...entry,
                        status:
                          entry.status === "failed" ? entry.status : "done",
                      }));
                return {
                  status: status === "running" ? "running" : "done",
                  lastMessage: message,
                  lastError: null,
                  proofreadingId: proofreadRunId ?? current.proofreadingId,
                  stageStatuses: nextStages,
                  lastHeartbeatAt: new Date().toISOString(),
                  isStalled: false,
                  run: createRunState(
                    status === "running" ? "running" : "done",
                  ),
                  subStates: mapStageStatusesToSubStates(nextStages),
                };
              });
              appendActivity("duplicate", message, {
                status,
                proofreadRunId,
              });

              pushAssistant(message, {
                label:
                  status === "running"
                    ? "Proofread already running"
                    : "Proofread already complete",
                tone: status === "running" ? "default" : "success",
              });

              if (status === "completed") {
                completed = true;
                refreshContent?.();
                onCompleted?.();
                openProofreadTab?.();
              } else if (status === "running") {
                skippedBecauseDuplicate = true;
              }

              return;
            }

            if (eventType === "tier_complete") {
              const tier = typeof event.tier === "string" ? event.tier : null;
              const proofreadingId =
                typeof event.proofreading_id === "string"
                  ? event.proofreading_id
                  : undefined;
              const itemCount = (() => {
                const rawCount =
                  typeof event.itemCount === "number"
                    ? event.itemCount
                    : typeof (event as Record<string, unknown>).item_count ===
                        "number"
                      ? ((event as Record<string, unknown>)
                          .item_count as number)
                      : null;
                return rawCount && Number.isFinite(rawCount) && rawCount >= 0
                  ? Math.round(rawCount)
                  : 0;
              })();
              const tierLabel = tier === "quick" ? "빠른" : "심층";
              const message = `${tierLabel} 교정 단계가 완료되었습니다.`;
              setProofreadingForProject((current) => {
                const nextStages = [...(current.stageStatuses ?? [])].map(
                  (entry) =>
                    tier && entry.tier === tier
                      ? { ...entry, status: "done" }
                      : entry,
                );
                const nextTierSummaries = {
                  ...(current.tierSummaries ?? {}),
                };
                if (tier) {
                  nextTierSummaries[tier] = {
                    label: message,
                    itemCount,
                    completedAt: new Date().toISOString(),
                  };
                }
                return {
                  status: "running",
                  lastMessage: message,
                  lastError: null,
                  proofreadingId: proofreadingId ?? current.proofreadingId,
                  stageStatuses: nextStages,
                  tierSummaries: nextTierSummaries,
                  lastHeartbeatAt: new Date().toISOString(),
                  isStalled: false,
                  run: createRunState("running"),
                  subStates: mapStageStatusesToSubStates(nextStages),
                };
              });
              appendActivity("tier_complete", message, {
                tier,
                proofreadingId,
                itemCount: itemCount > 0 ? itemCount : undefined,
              });
              return;
            }

            if (eventType === "complete") {
              completed = true;
              const proofreadingId =
                typeof event.proofreading_id === "string"
                  ? event.proofreading_id
                  : undefined;
              const reportRaw = (event as { report?: unknown }).report;
              const report = isRecord(reportRaw) ? reportRaw : undefined;
              const summaryRaw =
                report && isRecord(report.summary)
                  ? report.summary
                  : undefined;
              const countsSourceRaw =
                summaryRaw && isRecord(summaryRaw.countsBySubfeature)
                  ? summaryRaw.countsBySubfeature
                  : undefined;
              const countsBySubfeature: Record<string, number> = {};
              if (countsSourceRaw) {
                for (const [key, value] of Object.entries(countsSourceRaw)) {
                  if (typeof value === "number" && Number.isFinite(value)) {
                    countsBySubfeature[key] = value;
                  }
                }
              }
              const totalIssues = Object.values(countsBySubfeature).reduce(
                (acc, count) => acc + count,
                0,
              );
              const tierIssueCounts: Record<string, number> = {};
              Object.entries(proofreading.tierSummaries ?? {}).forEach(
                ([key, info]) => {
                  tierIssueCounts[key] = info?.itemCount ?? 0;
                },
              );
              const notesKo =
                typeof summaryRaw?.notes_ko === "string"
                  ? summaryRaw.notes_ko.trim()
                  : undefined;
              const notesEn =
                typeof summaryRaw?.notes_en === "string"
                  ? summaryRaw.notes_en.trim()
                  : undefined;
              const completionSummary = {
                totalIssues,
                countsBySubfeature,
                tierIssueCounts,
                notesKo: notesKo?.length ? notesKo : undefined,
                notesEn: notesEn?.length ? notesEn : undefined,
              };
              setProofreadingForProject((current) => ({
                status: "done",
                lastMessage: "교정이 완료되었습니다.",
                lastError: null,
                proofreadingId: proofreadingId ?? current.proofreadingId,
                updatedAt: new Date().toISOString(),
                stageStatuses: (current.stageStatuses ?? []).map((entry) => ({
                  ...entry,
                  status: entry.status === "failed" ? entry.status : "done",
                })),
                tierSummaries: current.tierSummaries ?? {},
                completionSummary,
                lastHeartbeatAt: new Date().toISOString(),
                isStalled: false,
              }));
              appendActivity("complete", "교정이 완료되었습니다.", {
                proofreadingId,
              });
              const tierParts = Object.entries(tierIssueCounts)
                .filter(([, value]) => value > 0)
                .map(([key, value]) => `${key}: ${value}건`);
              const topSubfeatures = Object.entries(countsBySubfeature)
                .filter(([, value]) => value > 0)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([key, value]) => `${key} ${value}건`);
              const summarySegments = [
                `총 이슈 ${totalIssues}건`,
                tierParts.length ? `티어 ${tierParts.join(", ")}` : null,
                topSubfeatures.length
                  ? `주요 서브피처 ${topSubfeatures.join(", ")}`
                  : null,
              ].filter(Boolean);
              pushAssistant(
                summarySegments.length
                  ? `교정이 완료되었습니다. ${summarySegments.join(" · ")}.`
                  : "교정이 완료되었습니다. 우측 패널에서 결과를 확인하세요.",
                {
                  label: "Proofread done",
                  tone: "success",
                  description: notesKo ?? notesEn,
                },
                undefined,
                true,
              );
              refreshContent?.();
              onCompleted?.();
              openProofreadTab?.();
              return;
            }

            if (eventType === "error") {
              encounteredError = true;
              const reason =
                typeof event.reason === "string" ? event.reason : null;
              const projectStatus =
                typeof event.projectStatus === "string"
                  ? event.projectStatus
                  : null;
              const conflictStatus =
                typeof event.conflictStatus === "string"
                  ? event.conflictStatus
                  : null;
              const errorMessage =
                typeof event.message === "string"
                  ? event.message
                  : "Unknown error";

              const nextLastMessage = (() => {
                if (reason === "already_running") {
                  return "이미 진행 중인 교정 작업이 있어 새 작업을 시작하지 않았습니다.";
                }
                if (reason === "project_inactive" && projectStatus) {
                  return `프로젝트 상태(${projectStatus}) 때문에 교정을 시작할 수 없습니다.`;
                }
                return "교정 중 오류가 발생했습니다.";
              })();

              setProofreadingForProject((current) => ({
                status: "failed",
                lastError: errorMessage,
                lastMessage: nextLastMessage,
                stageStatuses: (current.stageStatuses ?? []).map((entry) => ({
                  ...entry,
                  status: entry.status === "done" ? entry.status : "failed",
                })),
                lastHeartbeatAt: new Date().toISOString(),
                isStalled: false,
              }));

              appendActivity("error", errorMessage, {
                ...event,
                reason,
                projectStatus,
                conflictStatus,
              });

              const badge = (() => {
                if (reason === "already_running") {
                  return {
                    label: "Proofread already running",
                    tone: "default" as const,
                    description: conflictStatus
                      ? `기존 작업 상태: ${conflictStatus}`
                      : undefined,
                  };
                }
                if (reason === "project_inactive") {
                  return {
                    label: "Proofread blocked",
                    tone: "error" as const,
                    description: projectStatus
                      ? `프로젝트 상태: ${projectStatus}`
                      : undefined,
                  };
                }
                return {
                  label: "Proofread error",
                  tone: "error" as const,
                  description: conflictStatus
                    ? `추가 정보: ${conflictStatus}`
                    : undefined,
                };
              })();

              pushAssistant(nextLastMessage, badge, undefined, true);
            }
          },
        });

        if (!completed && !encounteredError && !skippedBecauseDuplicate) {
          setProofreadingForProject((current) => ({
            ...current,
            status: "failed",
            lastError: "교정 결과를 받지 못했습니다.",
            lastMessage: "교정이 비정상적으로 종료되었습니다.",
            stageStatuses: (current.stageStatuses ?? []).map((entry) => ({
              ...entry,
              status: entry.status === "done" ? entry.status : "failed",
            })),
            isStalled: false,
          }));
          appendActivity("error", "교정이 비정상적으로 종료되었습니다.");
          pushAssistant(
            "교정이 비정상적으로 종료되었습니다.",
            {
              label: "Proofread failed",
              tone: "error",
            },
            undefined,
            true,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setProofreadingForProject((current) => ({
          ...current,
          status: "failed",
          lastError: message,
          lastMessage: message
            ? `교정 중 오류가 발생했습니다: ${message}`
            : "교정 중 오류가 발생했습니다.",
          stageStatuses: (current.stageStatuses ?? []).map((entry) => ({
            ...entry,
            status: entry.status === "done" ? entry.status : "failed",
          })),
          isStalled: false,
        }));
        appendActivity("error", "교정 중 오류가 발생했습니다.", {
          message,
        });
      }
    },
    [
      proofreading.status,
      proofreading.tierSummaries,
      token,
      projectId,
      translationJobId,
      hasTranslation,
      pushAssistant,
      setProofreadingForProject,
      refreshContent,
      onCompleted,
      openProofreadTab,
      appendActivity,
    ],
  );

  const setStartProofreadCommand = useProofreadCommandStore(
    (state) => state.setStartProofread,
  );

  useEffect(() => {
    setStartProofreadCommand(startProofread);
    return () => setStartProofreadCommand(null);
  }, [setStartProofreadCommand, startProofread]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (
        (proofreading.status === "running" ||
          proofreading.status === "queued") &&
        proofreading.lastHeartbeatAt
      ) {
        const last = Date.parse(proofreading.lastHeartbeatAt);
        if (!Number.isNaN(last) && last > 0) {
          const diff = Date.now() - last;
          if (diff > DEFAULT_STALL_THRESHOLD_MS && !proofreading.isStalled) {
            setProofreadingForProject({ isStalled: true });
            appendActivity(
              "stalled",
              "최근 heartbeat가 지연되고 있습니다.",
              undefined,
              { updateHeartbeat: false },
            );
          } else if (
            diff <= DEFAULT_STALL_THRESHOLD_MS &&
            proofreading.isStalled
          ) {
            setProofreadingForProject({ isStalled: false });
            appendActivity(
              "resumed",
              "교정 heartbeat가 복구되었습니다.",
              undefined,
              { updateHeartbeat: false },
            );
          }
        }
      } else if (proofreading.isStalled) {
        setProofreadingForProject({ isStalled: false });
      }
    }, 5000);

    return () => window.clearInterval(interval);
  }, [
    proofreading.status,
    proofreading.lastHeartbeatAt,
    proofreading.isStalled,
    setProofreadingForProject,
    appendActivity,
    pushAssistant,
  ]);

  const canStart = useMemo(
    () =>
      proofreading.status === "idle" ||
      proofreading.status === "failed" ||
      proofreading.status === "done",
    [proofreading.status],
  );

  return {
    state: proofreading,
    canStart,
    startProofread,
  };
};
