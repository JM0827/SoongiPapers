import { useCallback, useEffect, useMemo, useRef } from "react";
import { api } from "../services/api";
import { dedupeAgentPages, normalizeAgentPageEvent } from "../lib/agentPage";
import type {
  ChatAction,
  ProofreadRunSummary,
  ProofreadingReport,
  ProofreadingReportSummary,
} from "../types/domain";
import { useWorkflowStore } from "../store/workflow.store";
import type {
  AgentRunState,
  AgentSubState,
  ProofreadAgentPageV2,
  ProofreadingAgentState,
  ProofreadingStatus,
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

const MAX_PROOFREAD_PAGE_HISTORY = 48;
const MAX_PROOFREAD_CURSOR_HISTORY = 96;

const trimHistory = <T,>(values: T[], limit: number): T[] =>
  values.length > limit ? values.slice(values.length - limit) : values;

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

  const activeRunIdRef = useRef<string | null>(null);
  const activeProofreadingIdRef = useRef<string | null>(null);
  const reconnectAttemptedRef = useRef(false);
  const passiveStreamAbortRef = useRef<(() => void) | null>(null);
  const fallbackInFlightRef = useRef(false);
  const cursorQueueRef = useRef<CursorTask[]>([]);
  const cursorProcessingRef = useRef(false);

  const clearPassiveStream = useCallback(() => {
    if (passiveStreamAbortRef.current) {
      passiveStreamAbortRef.current();
      passiveStreamAbortRef.current = null;
    }
  }, []);

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

  type ProcessProofreadEventResult = {
    completed: boolean;
    encounteredError: boolean;
    duplicateRunning: boolean;
    runId: string | null;
    proofreadingId: string | null;
    nextCursor?: CursorTask | null;
  };

  type CursorTask = {
    cursor: string;
    runId: string;
    proofreadingId: string | null;
  };

  const buildCompletionSummaryFromReport = useCallback(
    (report: ProofreadingReport | null | undefined) => {
      if (!report) return null;
      const summary = (report.summary ?? {}) as (
        ProofreadingReportSummary & Record<string, unknown>
      );
      const countsSourceRaw = (summary.countsBySubfeature ??
        (summary['counts_by_subfeature'] as Record<string, unknown> | undefined) ??
        {}) as Record<string, unknown>;
      const countsBySubfeature = Object.entries(countsSourceRaw).reduce<Record<string, number>>(
        (acc, [key, value]) => {
          if (typeof value === 'number' && Number.isFinite(value)) {
            acc[key] = value;
          }
          return acc;
        },
        {},
      );
      const totalIssues = Object.values(countsBySubfeature).reduce(
        (acc, count) => acc + count,
        0,
      );
      const tierIssueCounts = Object.entries(
        summary.tierIssueCounts ?? summary.tier_issue_counts ?? {},
      ).reduce<Record<string, number>>((acc, [key, value]) => {
        if (typeof value === "number" && Number.isFinite(value)) {
          acc[key] = value;
        }
        return acc;
      }, {});
      const downshiftCount =
        summary.downshiftCount ?? summary.downshift_count ?? undefined;
      const forcedPaginationCount =
        summary.forcedPaginationCount ?? summary.forced_pagination_count ?? undefined;
      const cursorRetryCount =
        summary.cursorRetryCount ?? summary.cursor_retry_count ?? undefined;

      return {
        totalIssues,
        countsBySubfeature,
        tierIssueCounts,
        notesKo: summary.notes_ko ?? undefined,
        notesEn: summary.notes_en ?? undefined,
        downshiftCount,
        forcedPaginationCount,
        cursorRetryCount,
      } satisfies ProofreadingAgentState["completionSummary"];
    },
    [],
  );

  const buildTierSummariesFromReport = useCallback(
    (
      tierReports:
        | Partial<Record<"quick" | "deep", ProofreadingReport | null>>
        | null
        | undefined,
      updatedAt: string | null,
    ) => {
      const result: ProofreadingAgentState["tierSummaries"] = {};
      if (!tierReports) return result;
      const completedAt = updatedAt ?? new Date().toISOString();
      Object.entries(tierReports).forEach(([tier, report]) => {
        if (!report) return;
        const summary = report.summary ?? {};
        const itemCountSource =
          (summary as { item_count?: unknown }).item_count ??
          (summary as { itemCount?: unknown }).itemCount;
        const itemCount =
          typeof itemCountSource === "number" && Number.isFinite(itemCountSource)
            ? Math.max(0, Math.floor(itemCountSource))
            : report.results?.reduce(
                (acc: number, bucket) => acc + (bucket.items?.length ?? 0),
                0,
              ) ?? 0;
        const downshift =
          (summary as { downshift_count?: number }).downshift_count ??
          (summary as { downshiftCount?: number }).downshiftCount ?? undefined;
        const forcedPagination =
          (summary as { forced_pagination_count?: number })
            .forced_pagination_count ??
          (summary as { forcedPaginationCount?: number }).forcedPaginationCount ??
          undefined;
        const cursorRetry =
          (summary as { cursor_retry_count?: number }).cursor_retry_count ??
          (summary as { cursorRetryCount?: number }).cursorRetryCount ?? undefined;
        result[tier] = {
          label: tier === "quick" ? "빠른 교정 단계" : "심층 교정 단계",
          itemCount,
          completedAt,
          downshiftCount: downshift ?? undefined,
          forcedPaginationCount: forcedPagination ?? undefined,
          cursorRetryCount: cursorRetry ?? undefined,
        };
      });
      return result;
    },
    [],
  );

  const applySummaryToState = useCallback(
    (summary: ProofreadRunSummary, reason: string) => {
      const completionSummary = buildCompletionSummaryFromReport(summary.report);
      const tierSummaries = buildTierSummariesFromReport(
        summary.tierReports,
        summary.updatedAt,
      );

      const normalizedStatus =
        summary.proofreading.status?.toLowerCase?.() ?? null;
      const normalizedRunStatus = summary.runStatus?.toLowerCase?.() ?? null;
      const normalizedWorkflowStatus =
        summary.workflowRun?.status?.toLowerCase?.() ?? null;

      let nextStatus: ProofreadingStatus = "running";
      if (
        normalizedStatus === "completed" ||
        normalizedStatus === "done" ||
        normalizedWorkflowStatus === "succeeded"
      ) {
        nextStatus = "done";
      } else if (
        normalizedStatus === "failed" ||
        normalizedStatus === "error" ||
        normalizedWorkflowStatus === "failed" ||
        normalizedRunStatus === "failed"
      ) {
        nextStatus = "failed";
      } else if (
        normalizedStatus === "cancelled" ||
        normalizedWorkflowStatus === "cancelled"
      ) {
        nextStatus = "failed";
      } else if (
        normalizedStatus === "running" ||
        normalizedStatus === "inprogress" ||
        normalizedStatus === "in_progress" ||
        normalizedRunStatus === "running"
      ) {
        nextStatus = "recovering";
      }

      const fallbackMessage =
        nextStatus === "done"
          ? "교정이 완료된 요약 정보를 복구했습니다."
          : nextStatus === "failed"
            ? "교정 상태가 비정상적으로 종료되어 요약 정보를 불러왔습니다."
            : "교정 상태를 요약 정보로 복구했습니다.";

      const updatedAt = summary.updatedAt ?? new Date().toISOString();

      setProofreadingForProject((current) => {
        const mergedTierSummaries = { ...current.tierSummaries, ...tierSummaries };
        const runStateStatus: ProofreadingStatus =
          nextStatus === 'failed' ? 'failed' : nextStatus === 'done' ? 'done' : nextStatus;
        return {
          ...current,
          status: nextStatus,
          proofreadingId:
            summary.proofreading.id ?? summary.runId ?? current.proofreadingId,
          lastMessage: fallbackMessage,
          lastError: nextStatus === 'failed' ? current.lastError : null,
          tierSummaries: mergedTierSummaries,
          completionSummary,
          lastHeartbeatAt: updatedAt,
          isStalled: false,
          updatedAt,
          run: createRunState(runStateStatus, {
            willRetry: false,
          }),
          pendingCursors: [],
          needsFollowup: false,
        };
      });

      activeRunIdRef.current = summary.runId ?? activeRunIdRef.current;
      activeProofreadingIdRef.current =
        summary.proofreading.id ?? activeProofreadingIdRef.current;

      appendActivity("summary", fallbackMessage, {
        reason,
        runId: summary.runId,
        proofreadingId: summary.proofreading.id,
        status: summary.proofreading.status ?? summary.runStatus ?? null,
      });
    },
    [
      appendActivity,
      buildCompletionSummaryFromReport,
      buildTierSummariesFromReport,
      setProofreadingForProject,
    ],
  );

  const processProofreadEvent = useCallback(
    (event: Record<string, unknown>): ProcessProofreadEventResult => {
      const outcome: ProcessProofreadEventResult = {
        completed: false,
        encounteredError: false,
        duplicateRunning: false,
        runId: null,
        proofreadingId: null,
        nextCursor: null,
      };

      const eventType = typeof event.type === "string" ? event.type : "";
      const payload = isRecord(event.data) ? event.data : event;

      const getString = (value: unknown): string | null =>
        typeof value === "string" ? value : null;

      const detectedRunId =
        getString((payload as Record<string, unknown>).run_id) ??
        getString((payload as Record<string, unknown>).proofread_run_id) ??
        getString((event as Record<string, unknown>).run_id) ??
        null;
      const detectedProofreadingId =
        getString((payload as Record<string, unknown>).proofreading_id) ??
        getString((payload as Record<string, unknown>).proofread_id) ??
        null;

      if (detectedRunId) outcome.runId = detectedRunId;
      if (detectedProofreadingId) outcome.proofreadingId = detectedProofreadingId;

      if (eventType === "progress") {
        const rawMessage =
          getString((event as Record<string, unknown>).message) ??
          getString((payload as Record<string, unknown>).message) ??
          undefined;
        const progressMessage = rawMessage?.trim()?.length
          ? rawMessage
          : "교정 작업이 진행 중입니다.";
        setProofreadingForProject((current) => ({
          status: "running",
          lastMessage: progressMessage,
          lastError: null,
          lastHeartbeatAt: new Date().toISOString(),
          isStalled: false,
          run: createRunState("running"),
          subStates: mapStageStatusesToSubStates(current.stageStatuses ?? []),
        }));
        appendActivity("progress", progressMessage);
        return outcome;
      }

      if (eventType === "heartbeat") {
        const timestamp =
          getString((event as Record<string, unknown>).timestamp) ??
          getString((payload as Record<string, unknown>).timestamp) ??
          new Date().toISOString();

        setProofreadingForProject((current) => ({
          lastHeartbeatAt: timestamp,
          isStalled: false,
          run: {
            ...current.run,
            heartbeatAt: Date.now(),
          },
        }));

        appendActivity(
          "heartbeat",
          "교정 heartbeat가 수신되었습니다.",
          {
            timestamp,
          },
          { updateHeartbeat: false },
        );

        return outcome;
      }

      if (eventType === "workflow") {
        const runStatus =
          getString((event as Record<string, unknown>).status) ??
          getString((payload as Record<string, unknown>).status) ??
          "unknown";
        const runId =
          getString((event as Record<string, unknown>).runId) ??
          getString((payload as Record<string, unknown>).runId) ??
          undefined;
        const label =
          getString((event as Record<string, unknown>).label) ??
          getString((payload as Record<string, unknown>).label) ??
          undefined;
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
          outcome.encounteredError = true;
          setProofreadingForProject((current) => ({
            ...current,
            status: "failed",
            lastError:
              getString((event as Record<string, unknown>).message) ??
              getString((payload as Record<string, unknown>).message) ??
              "프로젝트 상태 때문에 교정 작업을 시작할 수 없습니다.",
            lastMessage: "교정 워크플로우 요청이 거절되었습니다.",
            run: createRunState("failed"),
            subStates: mapStageStatusesToSubStates(
              current.stageStatuses ?? [],
            ),
          }));
        }

        return outcome;
      }

      if (eventType === "items") {
        const pageSource =
          isRecord(payload.page) && payload.page !== null
            ? (payload.page as Record<string, unknown>)
            : (payload as Record<string, unknown>);
        const envelope = normalizeAgentPageEvent(pageSource);
        if (!envelope) {
          return outcome;
        }

        const tier = getString(payload.tier);
        const stageKey = getString(payload.key);
        const eventRunId =
          getString((payload as Record<string, unknown>).run_id) ??
          outcome.runId ??
          activeRunIdRef.current ??
          null;
        const chunkIndex =
          typeof (payload as Record<string, unknown>).chunkIndex === 'number'
            ? ((payload as Record<string, unknown>).chunkIndex as number)
            : typeof (payload as Record<string, unknown>).chunk_index === 'number'
              ? ((payload as Record<string, unknown>).chunk_index as number)
              : null;
        const dedupeKey = [
          envelope.run_id,
          tier ?? '',
          stageKey ?? '',
          envelope.chunk_id,
          chunkIndex ?? '',
          envelope.next_cursor ?? '',
        ].join(':');

        let zeroItemRunDetected = false;

        setProofreadingForProject((current) => {
          const nextPages = [...(current.pages ?? [])];
          const candidate: ProofreadAgentPageV2 = {
            ...envelope,
            dedupeKey,
            pageIndex: chunkIndex ?? null,
            stageKey: stageKey ?? null,
            tierKey: tier ?? null,
          };
          const existingIndex = nextPages.findIndex(
            (page) =>
              page.dedupeKey === dedupeKey ||
              (page.run_id === candidate.run_id &&
                page.chunk_id === candidate.chunk_id &&
                page.pageIndex === candidate.pageIndex &&
                page.tierKey === candidate.tierKey),
          );
          if (existingIndex >= 0) {
            nextPages[existingIndex] = {
              ...nextPages[existingIndex],
              ...candidate,
            };
          } else {
            nextPages.push(candidate);
          }

          const previousItemCount = (current.pages ?? []).reduce(
            (acc, page) =>
              acc + (page.stats?.item_count ?? page.items.length ?? 0),
            0,
          );
          const dedupedPages = dedupeAgentPages(nextPages);
          const limitedPages = trimHistory(
            dedupedPages,
            MAX_PROOFREAD_PAGE_HISTORY,
          );
          const totalItemsAfter = limitedPages.reduce(
            (acc, page) =>
              acc + (page.stats?.item_count ?? page.items.length ?? 0),
            0,
          );
          zeroItemRunDetected =
            !candidate.has_more &&
            (candidate.stats?.item_count ?? candidate.items.length ?? 0) === 0 &&
            previousItemCount === 0 &&
            totalItemsAfter === 0;
          const baseRunStatus =
            current.run.status === 'idle' ? 'running' : current.run.status;
          const nextRunStatus = zeroItemRunDetected ? 'done' : baseRunStatus;

          return {
            status: zeroItemRunDetected
              ? 'done'
              : current.status === 'idle'
                ? 'running'
                : current.status,
            proofreadingId:
              getString(payload.proofreading_id) ??
              getString(payload.proofread_id) ??
              current.proofreadingId,
           pages: zeroItemRunDetected ? [] : limitedPages,
           lastEnvelope: zeroItemRunDetected ? null : candidate,
           lastMessage: zeroItemRunDetected
              ? '교정 결과 페이지가 비어 있습니다.'
              : current.lastMessage ?? '교정 결과가 수신되고 있습니다.',
            lastError: null,
            run: createRunState(nextRunStatus, {
              willRetry: zeroItemRunDetected ? false : candidate.has_more,
              heartbeatAt: Date.now(),
              nextRetryDelayMs: current.run.nextRetryDelayMs ?? null,
            }),
            pendingCursors: zeroItemRunDetected ? [] : current.pendingCursors,
            needsFollowup: zeroItemRunDetected
              ? false
              : current.needsFollowup ?? false,
          };
        });

        appendActivity(
          'items',
          zeroItemRunDetected
            ? '교정 결과 페이지가 비어 있습니다.'
            : envelope.has_more
              ? '교정 결과 페이지를 수신했습니다. 추가 페이지를 준비 중입니다.'
              : '교정 결과 페이지를 수신했습니다.',
          {
            tier,
            key: stageKey,
            chunkId: envelope.chunk_id,
            hasMore: envelope.has_more,
            nextCursor: envelope.next_cursor,
            zeroItems: zeroItemRunDetected || undefined,
          },
          { updateHeartbeat: false },
        );

        const detectedProofId =
          getString(payload.proofreading_id) ??
          getString(payload.proofread_id);
        if (detectedProofId) {
          outcome.proofreadingId = detectedProofId;
        }
        const nextCursorValue =
          typeof envelope.next_cursor === 'string' && envelope.next_cursor.trim().length
            ? envelope.next_cursor
            : null;
        if (envelope.has_more && nextCursorValue) {
          outcome.nextCursor = {
            cursor: nextCursorValue,
            runId: eventRunId ?? envelope.run_id,
            proofreadingId: detectedProofId ?? outcome.proofreadingId ?? activeProofreadingIdRef.current ?? null,
          };
        }
        outcome.runId = eventRunId ?? outcome.runId;
        return outcome;
      }

      if (eventType === "stage") {
        const tier = getString(payload.tier);
        const key = getString(payload.key);
        const label = getString(payload.label) ?? key ?? tier ?? "단계";
        const statusRaw =
          getString(payload.status) ?? getString((event as Record<string, unknown>).status) ?? "in_progress";
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
        return outcome;
      }

      if (eventType === "duplicate") {
        const status = getString(payload.status) ?? "completed";
        const proofreadRunId =
          getString((payload as Record<string, unknown>).proofread_run_id) ??
          undefined;
        const message =
          status === "running"
            ? "같은 번역본에 대한 교정이 이미 진행 중입니다. 잠시 후 결과를 확인해 주세요."
            : "같은 번역본에 대한 교정 결과가 이미 존재합니다.";

        setProofreadingForProject((current) => {
          const nextStages =
            status === "running"
              ? current.stageStatuses ?? []
              : (current.stageStatuses ?? []).map((entry) => ({
                  ...entry,
                  status: entry.status === "failed" ? entry.status : "done",
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

        outcome.duplicateRunning = status === "running";
        if (status === "completed") {
          refreshContent?.();
          onCompleted?.();
          openProofreadTab?.();
          outcome.completed = true;
        }

        return outcome;
      }

      if (eventType === "tier_complete") {
        const tier = getString(payload.tier);
        const proofreadingId =
          getString(payload.proofreading_id) ??
          outcome.proofreadingId ??
          null;
        const rawCount =
          typeof (payload as Record<string, unknown>).itemCount === "number"
            ? (payload as Record<string, unknown>).itemCount
            : typeof (payload as Record<string, unknown>).item_count ===
                "number"
              ? (payload as Record<string, unknown>).item_count
              : null;
        const itemCount =
          typeof rawCount === 'number' && Number.isFinite(rawCount)
            ? Math.max(0, Math.floor(rawCount))
            : 0;
        const tierLabel = tier === "quick" ? "빠른" : "심층";
        const message = `${tierLabel} 교정 단계가 완료되었습니다.`;
        setProofreadingForProject((current) => {
          const nextStages = [...(current.stageStatuses ?? [])].map((entry) =>
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
        return outcome;
      }

      if (eventType === "complete") {
        const proofreadingId =
          getString(payload.proofreading_id) ??
          outcome.proofreadingId ??
          null;
        const reportRaw = (event as { report?: unknown }).report ??
          (payload as { report?: unknown }).report;
        const report = isRecord(reportRaw) ? (reportRaw as ProofreadingReport) : undefined;
        const summaryRaw =
          report && isRecord(report.summary) ? report.summary : undefined;
        const countsSourceRaw =
          summaryRaw && isRecord(summaryRaw.countsBySubfeature)
            ? summaryRaw.countsBySubfeature
            : summaryRaw && isRecord(summaryRaw.counts_by_subfeature)
              ? summaryRaw.counts_by_subfeature
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
        pushAssistant(
          "교정이 완료되었습니다.",
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
        outcome.completed = true;
        return outcome;
      }

      if (eventType === "error") {
        outcome.encounteredError = true;
        const reason = getString(payload.reason);
        const projectStatus = getString(payload.projectStatus);
        const conflictStatus = getString(payload.conflictStatus);
        const errorMessage =
          getString(payload.message) ?? "Unknown error";

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
        return outcome;
      }

      if (eventType === "end") {
        const completedFlag = Boolean(payload.completed);
        if (!completedFlag) {
          appendActivity("end", "교정 스트림이 비정상적으로 종료되었습니다.", {
            reason: getString(payload.reason) ?? undefined,
          });
        }
        if (completedFlag) {
          outcome.completed = true;
        } else {
          outcome.encounteredError = true;
        }
        return outcome;
      }

      return outcome;
    },
    [
      appendActivity,
      onCompleted,
      openProofreadTab,
      pushAssistant,
      refreshContent,
      setProofreadingForProject,
      proofreading.tierSummaries,
    ],
  );

  const triggerProofreadFallback = useCallback(
    async (
      reason: string,
      identifiers?: { runId?: string | null; proofreadingId?: string | null },
    ) => {
      if (!token || !projectId) {
        return;
      }
      if (fallbackInFlightRef.current) {
        return;
      }
      fallbackInFlightRef.current = true;

      cursorQueueRef.current = [];
      cursorProcessingRef.current = false;
      setProofreadingForProject(() => ({
        pendingCursors: [],
        processedCursors: [],
        needsFollowup: false,
      }));

      const targetRunId = identifiers?.runId ?? activeRunIdRef.current;
      const targetProofreadingId =
        identifiers?.proofreadingId ?? activeProofreadingIdRef.current;

      appendActivity("fallback", "교정 요약 정보를 불러옵니다.", {
        reason,
        runId: targetRunId ?? null,
        proofreadingId: targetProofreadingId ?? null,
      });

      try {
        const summary = await api.fetchProofreadSummary(token, projectId, {
          runId: targetRunId ?? undefined,
          proofreadingId: targetProofreadingId ?? undefined,
        });

        if (!summary) {
          setProofreadingForProject((current) => ({
            ...current,
            status: "failed",
            lastError:
              current.lastError ?? "교정 결과 요약을 찾지 못했습니다.",
            lastMessage: "교정 스트림이 끊겨 요약 정보를 찾지 못했습니다.",
            isStalled: false,
            run: createRunState("failed", { willRetry: false }),
          }));
          appendActivity("fallback_failed", "교정 요약을 찾지 못했습니다.", {
            reason,
            runId: targetRunId ?? null,
            proofreadingId: targetProofreadingId ?? null,
          });
          pushAssistant(
            "교정 요약을 찾지 못했습니다. 다시 시도해 주세요.",
            {
              label: "Proofread fallback failed",
              tone: "error",
            },
            undefined,
            true,
          );
          return;
        }

        applySummaryToState(summary, reason);
        pushAssistant(
          "교정 상태를 최신 요약으로 복구했습니다.",
          { label: "Proofread recovered", tone: "success" },
          undefined,
          true,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendActivity("fallback_error", "교정 요약 요청이 실패했습니다.", {
          reason,
          error: message,
        });
        setProofreadingForProject((current) => ({
          ...current,
          status: "failed",
          lastError: message,
          lastMessage: "교정 스트림 복구에 실패했습니다.",
          isStalled: false,
          run: createRunState("failed", { willRetry: false }),
        }));
        pushAssistant(
          "교정 상태 복구에 실패했습니다. 다시 시도해 주세요.",
          {
            label: "Proofread fallback failed",
            tone: "error",
            description: message,
          },
          undefined,
          true,
        );
      } finally {
        fallbackInFlightRef.current = false;
        reconnectAttemptedRef.current = false;
        clearPassiveStream();
      }
    },
    [
      applySummaryToState,
      appendActivity,
      clearPassiveStream,
      projectId,
      pushAssistant,
      setProofreadingForProject,
      token,
    ],
  );

  const scheduleCursorDrain = useCallback(() => {
    if (cursorProcessingRef.current) return;
    if (!token || !projectId) return;
    if (!cursorQueueRef.current.length) return;

    cursorProcessingRef.current = true;

    const drain = async () => {
      const queueTask = (newTask: CursorTask) => {
        if (!newTask.cursor || !newTask.runId) return;
        const alreadyQueued = cursorQueueRef.current.some(
          (entry) => entry.cursor === newTask.cursor,
        );
        if (!alreadyQueued) {
          cursorQueueRef.current.unshift(newTask);
        }
        setProofreadingForProject((current) => {
          const processed = new Set(current.processedCursors ?? []);
          if (processed.has(newTask.cursor)) {
            return {};
          }
          const pending = new Set(current.pendingCursors ?? []);
          if (!pending.has(newTask.cursor)) {
            pending.add(newTask.cursor);
            return {
              pendingCursors: trimHistory(
                Array.from(pending),
                MAX_PROOFREAD_CURSOR_HISTORY,
              ),
            };
          }
          return {};
        });
      };
      while (cursorQueueRef.current.length) {
        const task = cursorQueueRef.current.shift()!;
        try {
          const response = await api.fetchProofreadItems({
            token,
            projectId,
            runId: task.runId,
            cursor: task.cursor,
          });

          setProofreadingForProject((current) => {
            const pending = (current.pendingCursors ?? []).filter(
              (value) => value !== task.cursor,
            );
            const pendingHistory = trimHistory(
              pending,
              MAX_PROOFREAD_CURSOR_HISTORY,
            );
            const processed = new Set(current.processedCursors ?? []);
            processed.add(task.cursor);
            const processedHistory = trimHistory(
              Array.from(processed),
              MAX_PROOFREAD_CURSOR_HISTORY,
            );
            const hasPending = pendingHistory.length > 0;
            return {
              pendingCursors: pendingHistory,
              processedCursors: processedHistory,
              needsFollowup: hasPending
                ? current.needsFollowup ?? false
                : false,
            };
          });

          for (const event of response.events ?? []) {
            const outcome = processProofreadEvent(
              event as Record<string, unknown>,
            );
            if (outcome.nextCursor) {
              queueTask(outcome.nextCursor);
            }
          }

          if (response.nextCursor) {
            queueTask({
              cursor: response.nextCursor,
              runId: task.runId,
              proofreadingId: task.proofreadingId,
            });
          }

          if (!response.hasMore) {
            continue;
          }
        } catch (error) {
          setProofreadingForProject((current) => ({
            pendingCursors: (current.pendingCursors ?? []).filter(
              (value) => value !== task.cursor,
            ),
            processedCursors: current.processedCursors ?? [],
            needsFollowup: true,
          }));
          appendActivity(
            "items_retry_failed",
            "교정 추가 페이지를 불러오지 못했습니다.",
            {
              cursor: task.cursor,
              error: error instanceof Error ? error.message : String(error),
            },
          );
          triggerProofreadFallback("cursor-fetch-error", {
            runId: task.runId,
            proofreadingId: task.proofreadingId,
          });
          break;
        }
      }
      cursorProcessingRef.current = false;
      if (cursorQueueRef.current.length) {
        scheduleCursorDrain();
      }
    };

    drain().catch((error) => {
      cursorProcessingRef.current = false;
      appendActivity(
        "items_retry_failed",
        "교정 추가 페이지 처리 중 오류가 발생했습니다.",
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
    });
  }, [
    appendActivity,
    processProofreadEvent,
    projectId,
    setProofreadingForProject,
    token,
    triggerProofreadFallback,
  ]);

  const enqueueCursor = useCallback(
    (task: CursorTask, options?: { skipDrain?: boolean; prepend?: boolean }) => {
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

      setProofreadingForProject((current) => {
        const processed = new Set(current.processedCursors ?? []);
        if (processed.has(task.cursor)) {
          return {};
        }
        const pending = new Set(current.pendingCursors ?? []);
        if (!pending.has(task.cursor)) {
          pending.add(task.cursor);
          return {
            pendingCursors: trimHistory(
              Array.from(pending),
              MAX_PROOFREAD_CURSOR_HISTORY,
            ),
          };
        }
        return {};
      });

      if (!options?.skipDrain) {
        scheduleCursorDrain();
      }
    },
    [scheduleCursorDrain, setProofreadingForProject],
  );

  const attemptStreamReconnect = useCallback(
    (
      reason: string,
      identifiers?: { runId?: string | null; proofreadingId?: string | null },
    ) => {
      if (!token || !projectId) {
        triggerProofreadFallback(`${reason}:unauthorized`, identifiers);
        return;
      }

      const targetRunId = identifiers?.runId ?? activeRunIdRef.current;
      const targetProofreadingId =
        identifiers?.proofreadingId ?? activeProofreadingIdRef.current;

      if (!targetRunId && !targetProofreadingId) {
        triggerProofreadFallback(`${reason}:no-identifiers`, identifiers);
        return;
      }

      if (reconnectAttemptedRef.current) {
        triggerProofreadFallback(`${reason}:already-attempted`, identifiers);
        return;
      }

      reconnectAttemptedRef.current = true;
      clearPassiveStream();

      appendActivity("reconnect", "교정 스트림 재연결을 시도합니다.", {
        reason,
        runId: targetRunId ?? null,
        proofreadingId: targetProofreadingId ?? null,
      });

      try {
        passiveStreamAbortRef.current = api.subscribeProofreadStream({
          token,
          projectId,
          runId: targetRunId ?? undefined,
          proofreadingId: targetProofreadingId ?? undefined,
          onEvent: (incoming) => {
            const outcome = processProofreadEvent(
              incoming as unknown as Record<string, unknown>,
            );
            if (outcome.runId) activeRunIdRef.current = outcome.runId;
            if (outcome.proofreadingId)
              activeProofreadingIdRef.current = outcome.proofreadingId;
            if (outcome.nextCursor) {
              enqueueCursor(outcome.nextCursor);
            }
            if (outcome.completed || outcome.encounteredError) {
              reconnectAttemptedRef.current = false;
              clearPassiveStream();
              if (outcome.encounteredError && !outcome.completed) {
                triggerProofreadFallback(`${reason}:end`, {
                  runId: targetRunId,
                  proofreadingId: targetProofreadingId,
                });
              }
            }
          },
          onError: (error) => {
            appendActivity(
              "reconnect_error",
              "교정 스트림 재연결이 실패했습니다.",
              {
                reason,
                runId: targetRunId ?? null,
                proofreadingId: targetProofreadingId ?? null,
                error: error?.message ?? String(error),
              },
            );
            triggerProofreadFallback(`${reason}:stream-error`, {
              runId: targetRunId,
              proofreadingId: targetProofreadingId,
            });
          },
        });
      } catch (error) {
        appendActivity("reconnect_error", "교정 스트림 재연결이 실패했습니다.", {
          reason,
          error: error instanceof Error ? error.message : String(error),
          runId: targetRunId ?? null,
          proofreadingId: targetProofreadingId ?? null,
        });
        triggerProofreadFallback(`${reason}:exception`, {
          runId: targetRunId,
          proofreadingId: targetProofreadingId,
        });
      }
    },
    [
      appendActivity,
      clearPassiveStream,
      enqueueCursor,
      processProofreadEvent,
      projectId,
      triggerProofreadFallback,
      token,
    ],
  );

  const handleStreamInterruption = useCallback(
    (
      reason: string,
      identifiers?: { runId?: string | null; proofreadingId?: string | null },
    ) => {
      if (identifiers?.runId) {
        activeRunIdRef.current = identifiers.runId;
      }
      if (identifiers?.proofreadingId) {
        activeProofreadingIdRef.current = identifiers.proofreadingId;
      }
      attemptStreamReconnect(reason, identifiers);
    },
    [attemptStreamReconnect],
  );

  useEffect(() => {
    resetProofreading(projectId ?? null);
  }, [projectId, resetProofreading]);

  useEffect(
    () => () => {
      clearPassiveStream();
      cursorQueueRef.current = [];
      cursorProcessingRef.current = false;
    },
    [clearPassiveStream],
  );

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
        pendingCursors: [],
        processedCursors: [],
        needsFollowup: false,
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
      let streamRunId: string | null = null;
      let streamProofreadingId: string | null = null;

      activeRunIdRef.current = null;
      activeProofreadingIdRef.current = null;
      reconnectAttemptedRef.current = false;
      fallbackInFlightRef.current = false;
      clearPassiveStream();
      try {
        await api.requestProofreading(token, projectId, translationJobId, {
          label: options?.label ?? null,
          allowParallel: options?.allowParallel ?? false,
          runDeep: options?.runDeep ?? false,
          onEvent: (event) => {
            const outcome = processProofreadEvent(
              event as Record<string, unknown>,
            );
            if (outcome.runId) {
              streamRunId = outcome.runId;
            }
            if (outcome.proofreadingId) {
              streamProofreadingId = outcome.proofreadingId;
            }
            if (outcome.nextCursor) {
              enqueueCursor(outcome.nextCursor);
            }
            if (outcome.completed) {
              completed = true;
            }
            if (outcome.encounteredError) {
              encounteredError = true;
            }
            if (outcome.duplicateRunning) {
              skippedBecauseDuplicate = true;
            }
          },

        });

        if (!completed && !encounteredError && !skippedBecauseDuplicate) {
          if (streamRunId) {
            activeRunIdRef.current = streamRunId;
          }
          if (streamProofreadingId) {
            activeProofreadingIdRef.current = streamProofreadingId;
          }
          handleStreamInterruption("request-stream-incomplete", {
            runId: streamRunId,
            proofreadingId: streamProofreadingId,
          });
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
        handleStreamInterruption("request-stream-error", {
          runId: streamRunId,
          proofreadingId: streamProofreadingId,
        });
      }
    },
    [
      proofreading.status,
      token,
      projectId,
      translationJobId,
      hasTranslation,
      pushAssistant,
      setProofreadingForProject,
      appendActivity,
      enqueueCursor,
      processProofreadEvent,
      clearPassiveStream,
      handleStreamInterruption,
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
