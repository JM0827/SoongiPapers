import { useCallback, useMemo, useEffect } from "react";
import { api } from "../services/api";
import type {
  ChatAction,
  ProjectSummary,
  QualityAssessmentResultPayload,
} from "../types/domain";
import { useWorkflowStore } from "../store/workflow.store";
import type { QualityAgentState } from "../store/workflow.store";
import { useProjectStore } from "../store/project.store";

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

interface UseQualityAgentParams {
  token: string | null;
  projectId: string | null;
  originText: string;
  translationText: string;
  translationJobId?: string | null;
  pushAssistant: PushAssistant;
  onCompleted?: () => void;
  refreshContent?: () => void;
  openQualityDialog?: () => void;
  lifecycle?: {
    stage: string | null;
    score?: number | null;
    lastUpdatedAt?: string | null;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const unwrapEvaluation = (
  payload: unknown,
): QualityAssessmentResultPayload | null => {
  if (!isRecord(payload)) return null;
  const dataCandidate = payload["data"];
  if (isRecord(dataCandidate)) {
    return dataCandidate as QualityAssessmentResultPayload;
  }
  return payload as QualityAssessmentResultPayload;
};

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
  pushAssistant,
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
        lastError: "이전 품질 평가가 실패했습니다.",
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
      if (quality.status === "running") {
        pushAssistant("이미 품질 평가가 진행 중입니다.", {
          label: "Quality in progress",
          tone: "default",
        });
        return;
      }
      if (!token || !projectId) {
        pushAssistant(
          "인증 또는 프로젝트 정보가 없어 품질 평가를 실행할 수 없습니다.",
          {
            label: "Quality blocked",
            tone: "error",
          },
        );
        return;
      }
      if (!originText.trim() || !translationText.trim()) {
        pushAssistant("원문과 번역본이 모두 준비되었는지 확인해 주세요.", {
          label: "Missing texts",
          tone: "error",
        });
        return;
      }

      setQualityForProject({
        status: "running",
        lastError: null,
        updatedAt: new Date().toISOString(),
      });
      pushAssistant(
        "품질 평가를 준비 중입니다...",
        { label: "Quality queued", tone: "default" },
        undefined,
        true,
      );

      try {
        const activeProject = projects.find(
          (project) => project.project_id === projectId,
        ) ?? null;
        const evaluationModel = extractProjectModel(activeProject);

        const evaluationPayload = await api.evaluateQuality(token, {
          source: originText,
          translated: translationText,
          projectId,
          jobId: translationJobId ?? undefined,
          workflowLabel: options?.label ?? null,
          workflowAllowParallel: options?.allowParallel ?? false,
          model: evaluationModel,
        });
        const qualityResultPayload: QualityAssessmentResultPayload =
          unwrapEvaluation(evaluationPayload) ?? {};
        const overallScore =
          typeof qualityResultPayload.overallScore === "number"
            ? qualityResultPayload.overallScore
            : null;

        await api.saveQualityAssessment(token, {
          projectId,
          jobId: translationJobId ?? undefined,
          sourceText: originText,
          translatedText: translationText,
          qualityResult: qualityResultPayload,
          translationMethod: "auto",
          modelUsed: qualityResultPayload.meta?.model,
        });

        setQualityForProject({
          status: "done",
          score: overallScore,
          lastError: null,
          updatedAt: new Date().toISOString(),
        });
        pushAssistant(
          `품질 평가가 완료되었습니다. 총점 ${overallScore ?? "N/A"}점입니다.`,
          { label: "Quality done", tone: "success" },
          [{ type: "viewQualityReport", reason: "View quality report" }],
          true,
        );
        refreshContent?.();
        onCompleted?.();
        openQualityDialog?.();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setQualityForProject({
          status: "failed",
          lastError: message,
          updatedAt: new Date().toISOString(),
        });
        pushAssistant("품질 평가에 실패했습니다.", {
          label: "Quality failed",
          description: message,
          tone: "error",
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
      pushAssistant,
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
