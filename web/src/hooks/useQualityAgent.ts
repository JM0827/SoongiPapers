import { useCallback, useMemo, useEffect } from "react";
import { api } from "../services/api";
import type { QualityStreamEvent } from "../services/api";
import type { ProjectSummary } from "../types/domain";
import { useWorkflowStore } from "../store/workflow.store";
import type { QualityAgentState } from "../store/workflow.store";
import { useProjectStore } from "../store/project.store";

interface UseQualityAgentParams {
  token: string | null;
  projectId: string | null;
  originText: string;
  translationText: string;
  translationJobId?: string | null;
  onCompleted?: () => void;
  refreshContent?: () => void;
  openQualityDialog?: () => void;
  lifecycle?: {
    stage: string | null;
    score?: number | null;
    lastUpdatedAt?: string | null;
  };
}

const extractProjectModel = (
  project: ProjectSummary | null,
): string | undefined => {
  if (!project) return undefined;
  const meta = project.meta;
  if (!meta) return undefined;
  if (typeof meta === "string") {
    try {
      const parsed = JSON.parse(meta) as Record<string, unknown>;
      const candidate = parsed?.llmModel;
      return typeof candidate === "string" ? candidate : undefined;
    } catch (error) {
      console.warn("[qualityAgent] Failed to parse project meta string", error);
      return undefined;
    }
  }
  if (typeof meta === "object" && meta) {
    const candidate = (meta as Record<string, unknown>).llmModel;
    return typeof candidate === "string" ? candidate : undefined;
  }
  return undefined;
};

export const useQualityAgent = ({
  token,
  projectId,
  originText,
  translationText,
  translationJobId,
  onCompleted,
  refreshContent,
  openQualityDialog,
  lifecycle,
}: UseQualityAgentParams) => {
  const quality = useWorkflowStore((state) => state.quality);
  const setQuality = useWorkflowStore((state) => state.setQuality);
  const resetQuality = useWorkflowStore((state) => state.resetQuality);
  const projects = useProjectStore((state) => state.projects);

  const setQualityForProject = useCallback(
    (
      update:
        | Partial<QualityAgentState>
        | ((current: QualityAgentState) => Partial<QualityAgentState>),
    ) => {
      if (!projectId) return;
      setQuality(projectId, update);
    },
    [projectId, setQuality],
  );

  useEffect(() => {
    resetQuality(projectId ?? null);
  }, [projectId, resetQuality]);

  useEffect(() => {
    if (!lifecycle) return;
    const stage = lifecycle.stage?.toLowerCase() ?? null;
    if (!stage) return;
    if (!projectId) return;
    if (stage.includes("run") && quality.status === "idle") {
      setQualityForProject({ status: "running", lastError: null });
    } else if (
      (stage.includes("done") || stage.includes("complete")) &&
      quality.status === "idle"
    ) {
      setQualityForProject({
        status: "done",
        score: lifecycle.score ?? quality.score,
        updatedAt: lifecycle.lastUpdatedAt ?? quality.updatedAt,
      });
    } else if (stage.includes("fail") && quality.status === "idle") {
      setQualityForProject({
        status: "failed",
        lastError: "이전 품질 검토가 실패했습니다.",
      });
    }
  }, [
    lifecycle,
    projectId,
    quality.score,
    quality.status,
    quality.updatedAt,
    setQualityForProject,
  ]);

  const runQuality = useCallback(
    async (options?: { label?: string | null; allowParallel?: boolean }) => {
      if (quality.status === 'running') {
        return;
      }
      if (!token || !projectId) {
        return;
      }
      if (!originText.trim() || !translationText.trim()) {
        return;
      }

      const startTimestamp = new Date().toISOString();
      setQualityForProject({
        projectId,
        status: 'running',
        lastError: null,
        updatedAt: startTimestamp,
        chunksTotal: 0,
        chunksCompleted: 0,
        currentChunkIndex: null,
        chunkSummaries: [],
        lastMessage: '품질 검토를 준비하는 중입니다…',
      });

      const activeProject =
        projects.find((project) => project.project_id === projectId) ?? null;
      const evaluationModel = extractProjectModel(activeProject);

      const handleEvent = (event: QualityStreamEvent) => {
        switch (event.type) {
          case 'start':
            setQualityForProject({
              projectId,
              status: 'running',
              lastError: null,
              updatedAt: new Date().toISOString(),
              chunksTotal: event.totalChunks,
              chunksCompleted: 0,
              currentChunkIndex: null,
              chunkSummaries: Array.from({ length: event.totalChunks }, (_, index) => ({
                index,
                status: 'pending' as const,
                score: null,
                durationMs: null,
                requestId: null,
                maxOutputTokensUsed: null,
                usage: null,
                message: null,
                fallbackApplied: false,
                missingFields: [],
                attempts: null,
                preview: null,
              })),
              lastMessage: '청크 평가를 시작합니다…',
            });
            break;
          case 'chunk-start':
            setQualityForProject((current) => {
              const summaries = current.chunkSummaries.length
                ? [...current.chunkSummaries]
                : Array.from({ length: event.total }, (_, index) => ({
                    index,
                    status: 'pending' as const,
                    score: null,
                    durationMs: null,
                    requestId: null,
                    maxOutputTokensUsed: null,
                    usage: null,
                    message: null,
                    fallbackApplied: false,
                    missingFields: [],
                    attempts: null,
                    preview: null,
                  }));
              summaries[event.index] = {
                ...summaries[event.index],
                index: event.index,
                status: 'running',
                message: `청크 ${event.index + 1}/${event.total} 평가 중…`,
                fallbackApplied: false,
                missingFields: [],
                attempts: (summaries[event.index]?.attempts ?? 0) || 1,
                preview: null,
              };
              return {
                chunkSummaries: summaries,
                chunksTotal: Math.max(current.chunksTotal, event.total),
                currentChunkIndex: event.index,
                lastMessage: `청크 ${event.index + 1}/${event.total} 평가 중…`,
              };
            });
            break;
          case 'chunk-retry':
            setQualityForProject({
              lastMessage: `청크 ${event.index + 1} 토큰 한도 증가 (${event.from} → ${event.to})`,
            });
            break;
          case 'chunk-partial':
            setQualityForProject((current) => {
              const summaries = current.chunkSummaries.length
                ? [...current.chunkSummaries]
                : Array.from({ length: event.total }, (_, index) => ({
                    index,
                    status: 'pending' as const,
                    score: null,
                    durationMs: null,
                    requestId: null,
                    maxOutputTokensUsed: null,
                    usage: null,
                    message: null,
                    fallbackApplied: false,
                    missingFields: [],
                    attempts: null,
                    preview: null,
                  }));
              const summary = summaries[event.index] ?? {
                index: event.index,
                status: 'pending' as const,
                score: null,
                durationMs: null,
                requestId: null,
                maxOutputTokensUsed: null,
                usage: null,
                message: null,
                fallbackApplied: false,
                missingFields: [],
                attempts: null,
                preview: null,
              };
              const messageBase = event.fallbackApplied
                ? '필수 필드 누락으로 추정값을 적용했습니다.'
                : `필수 필드 누락: ${event.missingFields.join(', ') || '알 수 없음'}`;
              summaries[event.index] = {
                ...summary,
                status: event.fallbackApplied ? 'fallback' : 'partial',
                message: messageBase,
                fallbackApplied: event.fallbackApplied,
                missingFields: event.missingFields,
                attempts: event.attempt,
                preview: event.preview ?? null,
              };
              return {
                chunkSummaries: summaries,
                lastMessage: event.fallbackApplied
                  ? `청크 ${event.index + 1} 추정값으로 보정했습니다.`
                  : `청크 ${event.index + 1} 필드 누락 감지 (재시도 중)…`,
              };
            });
            break;
          case 'chunk-complete':
            setQualityForProject((current) => {
              const summaries = current.chunkSummaries.length
                ? [...current.chunkSummaries]
                : Array.from({ length: event.total }, (_, index) => ({
                    index,
                    status: 'pending' as const,
                    score: null,
                    durationMs: null,
                    requestId: null,
                    maxOutputTokensUsed: null,
                    usage: null,
                    message: null,
                    fallbackApplied: false,
                    missingFields: [],
                    attempts: null,
                    preview: null,
                  }));
              summaries[event.index] = {
                index: event.index,
                status: event.fallbackApplied ? 'fallback' : 'completed',
                score: event.result?.overallScore ?? null,
                durationMs: event.durationMs,
                requestId: event.requestId ?? null,
                maxOutputTokensUsed: event.maxOutputTokensUsed ?? null,
                usage: event.usage
                  ? {
                      promptTokens: event.usage.prompt_tokens ?? null,
                      completionTokens: event.usage.completion_tokens ?? null,
                      totalTokens: event.usage.total_tokens ?? null,
                    }
                  : null,
                message: event.fallbackApplied
                  ? '누락된 필드가 있어 추정값으로 보정된 결과입니다.'
                  : null,
                fallbackApplied: Boolean(event.fallbackApplied),
                missingFields: event.missingFields ?? [],
                attempts: event.attempts ?? summaries[event.index].attempts ?? null,
                preview: event.preview ?? summaries[event.index].preview ?? null,
              };
              const completed = summaries.filter(
                (summary) =>
                  summary.status === 'completed' || summary.status === 'fallback',
              ).length;
              return {
                chunkSummaries: summaries,
                chunksCompleted: Math.min(
                  event.total,
                  Math.max(completed, current.chunksCompleted),
                ),
                currentChunkIndex: null,
                lastMessage: `청크 ${event.index + 1} 완료 (${completed}/${event.total})`,
              };
            });
            break;
          case 'progress':
            setQualityForProject({
              chunksCompleted: Math.min(event.total, event.completed),
            });
            break;
          case 'chunk-error':
            setQualityForProject((current) => {
              const summaries = current.chunkSummaries.length
                ? [...current.chunkSummaries]
                : [];
              if (summaries[event.index]) {
                summaries[event.index] = {
                  ...summaries[event.index],
                  status: 'error',
                  message: event.message,
                };
              }
              return {
                status: 'failed',
                lastError: event.message,
                lastMessage: event.message,
                currentChunkIndex: null,
                chunkSummaries: summaries,
              };
            });
            break;
          case 'complete':
            setQualityForProject((current) => ({
              chunksCompleted:
                event.result.meta?.chunks ?? current.chunksTotal ?? current.chunksCompleted,
              lastMessage: '품질 검토 결과를 집계하고 있습니다…',
              score: event.result.overallScore ?? current.score,
            }));
            break;
          case 'error':
            setQualityForProject({
              status: 'failed',
              lastError: event.message,
              lastMessage: event.message,
              currentChunkIndex: null,
            });
            break;
          default:
            break;
        }
      };

      try {
        const finalResult = await api.evaluateQualityStream(
          token,
          {
            source: originText,
            translated: translationText,
            projectId,
            jobId: translationJobId ?? undefined,
            workflowLabel: options?.label ?? null,
            workflowAllowParallel: options?.allowParallel ?? false,
            model: evaluationModel,
          },
          {
            onEvent: handleEvent,
          },
        );

        await api.saveQualityAssessment(token, {
          projectId,
          jobId: translationJobId ?? undefined,
          sourceText: originText,
          translatedText: translationText,
          qualityResult: finalResult,
          translationMethod: 'auto',
          modelUsed: finalResult.meta?.model,
        });

        setQualityForProject((current) => ({
          status: 'done',
          score: finalResult.overallScore ?? current.score,
          lastError: null,
          lastMessage: '품질 검토가 완료되었습니다.',
          updatedAt: new Date().toISOString(),
          chunksTotal:
            current.chunksTotal || finalResult.meta?.chunks || current.chunksTotal,
          chunksCompleted:
            finalResult.meta?.chunks ??
            Math.max(current.chunksCompleted, current.chunksTotal),
          currentChunkIndex: null,
          chunkSummaries: current.chunkSummaries,
        }));

        refreshContent?.();
        onCompleted?.();
        openQualityDialog?.();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        setQualityForProject({
          status: 'failed',
          lastError: message,
          lastMessage: message,
          updatedAt: new Date().toISOString(),
          currentChunkIndex: null,
        });
      }
    },
    [
      quality.status,
      token,
      projectId,
      originText,
      translationText,
      translationJobId,
      projects,
      setQualityForProject,
      refreshContent,
      onCompleted,
      openQualityDialog,
    ],
  );

  const canStart = useMemo(
    () => quality.status !== "running",
    [quality.status],
  );

  return {
    state: quality,
    canStart,
    runQuality,
  };
};
