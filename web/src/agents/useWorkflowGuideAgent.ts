import { useCallback, useEffect, useRef } from "react";
import type {
  ChatAction,
  DocumentProfileSummary,
  ProjectContent,
} from "../types/domain";
import type { ProjectContextSnapshot } from "../hooks/useProjectContext";
import { useWorkflowStore } from "../store/workflow.store";

export type WorkflowTaskType =
  | "collectMetadata"
  | "startTranslation"
  | "startProofread"
  | "startQuality"
  | "shareOriginSummaryPending"
  | "shareOriginSummary"
  | "shareTranslationSummary"
  | "celebrateComplete";

export interface WorkflowTask {
  id?: string;
  type: WorkflowTaskType;
  message: string;
  badge?: {
    label: string;
    description?: string;
    tone?: "default" | "success" | "error";
  };
  actions?: ChatAction[];
  autoStart?: boolean;
  payload?: Record<string, unknown>;
  stage?: "origin" | "translation" | "proofreading" | "quality";
}

export type WorkflowIntent =
  | { type: "redoTranslation"; mode?: "full" | "section" }
  | { type: "redoProofread"; mode?: "quick" | "deep" }
  | { type: "redoQuality"; mode?: "full" | "light" }
  | { type: "updateMetadata"; payload: { title?: string; author?: string } };

interface WorkflowGuideAgentOptions {
  projectId: string | null;
  snapshot: ProjectContextSnapshot;
  content?: ProjectContent | null;
  queueTask: (task: WorkflowTask) => void;
}

interface GuideState {
  projectId: string | null;
  metadataPrompted: boolean;
  originSummaryPendingNotified: boolean;
  originSummaryShared: boolean;
  translationPrompted: boolean;
  translationReadyHandled: boolean;
  translationSummaryShared: boolean;
  proofreadingReadyHandled: boolean;
  workflowCompleted: boolean;
}

const formatSummary = (
  profile: DocumentProfileSummary | null | undefined,
  prefix: string,
) => {
  if (!profile) return null;
  const segments: string[] = [];
  if (profile.summary?.story) segments.push(profile.summary.story);
  if (profile.summary?.intention)
    segments.push(`Intention: ${profile.summary.intention}`);
  if (profile.summary?.readerPoints?.length) {
    segments.push(
      `Reader takeaways: ${profile.summary.readerPoints.join(", ")}`,
    );
  }
  if (!segments.length) return null;
  return `${prefix}\n${segments.join("\n")}`;
};

export const useWorkflowGuideAgent = ({
  projectId,
  snapshot,
  content,
  queueTask,
}: WorkflowGuideAgentOptions) => {
  const translationState = useWorkflowStore((state) => state.translation);
  const proofreadingState = useWorkflowStore((state) => state.proofreading);
  const qualityState = useWorkflowStore((state) => state.quality);
  const projectProfile = content?.projectProfile ?? null;
  const originProfile =
    (content?.documentProfiles?.origin as DocumentProfileSummary | null) ??
    null;
  const translationProfile =
    (content?.documentProfiles?.translation as DocumentProfileSummary | null) ??
    null;

  const guideStateRef = useRef<GuideState>({
    projectId: null,
    metadataPrompted: false,
    originSummaryPendingNotified: false,
    originSummaryShared: false,
    translationPrompted: false,
    translationReadyHandled: false,
    translationSummaryShared: false,
    proofreadingReadyHandled: false,
    workflowCompleted: false,
  });

  const originAvailableFromContent = Boolean(
    content?.content?.origin?.content?.trim(),
  );
  const translationAvailableFromContent = Boolean(
    content?.content?.translation?.content?.trim(),
  );

  const originAvailable =
    originAvailableFromContent || Boolean(snapshot?.origin?.hasContent);
  const translationAvailable =
    translationAvailableFromContent ||
    Boolean(snapshot?.translation?.hasContent);

  const projectTitle = projectProfile?.title ?? snapshot?.projectTitle ?? "";

  const translationStage =
    snapshot?.lifecycle?.translation?.stage?.toLowerCase() ?? "none";
  const proofreadingStage =
    snapshot?.lifecycle?.proofreading?.stage?.toLowerCase() ?? "none";
  const qualityStage =
    snapshot?.lifecycle?.quality?.stage?.toLowerCase() ?? "none";

  const resetGuideState = useCallback(() => {
    guideStateRef.current = {
      projectId,
      metadataPrompted: false,
      originSummaryPendingNotified: false,
      originSummaryShared: false,
      translationPrompted: false,
      translationReadyHandled: false,
      translationSummaryShared: false,
      proofreadingReadyHandled: false,
      workflowCompleted: false,
    };
  }, [projectId]);

  useEffect(() => {
    if (guideStateRef.current.projectId !== projectId) {
      resetGuideState();
    }
  }, [projectId, resetGuideState]);

  const scheduleTask = useCallback(
    (task: WorkflowTask) => {
      queueTask({ ...task });
    },
    [queueTask],
  );

  const maybePromptMetadata = useCallback(() => {
    if (!projectId || !originAvailable) return;
    if (guideStateRef.current.metadataPrompted) return;

    const title = projectProfile?.title?.trim() ?? projectTitle?.trim() ?? "";
    const author = projectProfile?.meta?.author?.trim() ?? "";
    const needsTitle =
      !title || /^new project/i.test(title) || /^project\s*$/i.test(title);
    const needsAuthor = !author;
    if (!needsTitle && !needsAuthor) return;

    guideStateRef.current.metadataPrompted = true;
    const prompts: string[] = [];
    if (needsTitle)
      prompts.push("작품 제목을 알려주시면 메타데이터에 반영할게요.");
    if (needsAuthor) prompts.push("저자 이름도 함께 알려주시면 기록해 둘게요.");

    scheduleTask({
      type: "collectMetadata",
      message: prompts.join(" "),
      badge: { label: "Metadata needed", tone: "default" },
      autoStart: false,
      stage: "origin",
    });
  }, [projectId, originAvailable, projectProfile, projectTitle, scheduleTask]);

  const determineTargetLang = useCallback(() => {
    return (
      (snapshot?.targetLang ?? projectProfile?.targetLang ?? "")
        .trim() || "English"
    );
  }, [snapshot?.targetLang, projectProfile?.targetLang]);

  const scheduleTranslationPrompt = useCallback(() => {
    if (!projectId || !originAvailable) return;
    if (translationAvailable) return;
    if (
      translationState.status === "running" ||
      translationState.status === "queued"
    )
      return;
    if (guideStateRef.current.translationPrompted) return;

    guideStateRef.current.translationPrompted = true;
    const lang = determineTargetLang();
    scheduleTask({
      type: "startTranslation",
      message: `원문을 확인했습니다. 기본 설정에 따라 ${lang} 번역을 시작할까요? 필요하면 다른 언어를 말씀해 주세요!`,
      badge: { label: "Origin captured", tone: "default" },
      autoStart: false,
      actions: [
        {
          type: "startTranslation" as const,
          reason: "Begin translation",
          autoStart: false,
        },
      ],
      stage: "translation",
    });
  }, [
    projectId,
    originAvailable,
    translationAvailable,
    translationState.status,
    determineTargetLang,
    scheduleTask,
  ]);

  const maybeGuideOrigin = useCallback(() => {
    if (!projectId || !originAvailable) return;
    if (translationAvailable) return;
    if (
      translationState.status === "running" ||
      translationState.status === "queued"
    )
      return;

    if (guideStateRef.current.originSummaryShared) {
      scheduleTranslationPrompt();
      return;
    }

    if (!guideStateRef.current.originSummaryPendingNotified) {
      guideStateRef.current.originSummaryPendingNotified = true;
      scheduleTask({
        type: "shareOriginSummaryPending",
        message: "원문을 분석 중입니다. 잠시만 기다려 주세요.",
        badge: { label: "Origin summary prepping", tone: "default" },
        autoStart: false,
        stage: "origin",
      });
    }
  }, [
    projectId,
    originAvailable,
    translationAvailable,
    translationState.status,
    scheduleTask,
    scheduleTranslationPrompt,
  ]);

  const maybeShareOriginSummary = useCallback(() => {
    if (!projectId || !originAvailable) return;
    if (!originProfile || guideStateRef.current.originSummaryShared) return;
    const summary = formatSummary(originProfile, "원문 요약입니다:");
    if (!summary) return;

    guideStateRef.current.originSummaryShared = true;
    guideStateRef.current.originSummaryPendingNotified = false;
    scheduleTask({
      type: "shareOriginSummary",
      message: summary,
      badge: { label: "Origin summary", tone: "default" },
      autoStart: false,
      stage: "origin",
    });
    scheduleTranslationPrompt();
  }, [
    projectId,
    originAvailable,
    originProfile,
    scheduleTask,
    scheduleTranslationPrompt,
  ]);

  const maybeHandleTranslationReady = useCallback(() => {
    if (!projectId) return;
    if (translationState.projectId && translationState.projectId !== projectId)
      return;
    const translationFinished =
      translationAvailable || translationStage === "translated";
    if (!translationFinished) return;
    if (guideStateRef.current.translationReadyHandled) return;

    guideStateRef.current.translationReadyHandled = true;
    guideStateRef.current.translationSummaryShared = false;
    guideStateRef.current.proofreadingReadyHandled = false;
    guideStateRef.current.workflowCompleted = false;

    scheduleTask({
      type: "startProofread",
      message: "번역이 완료되었습니다. 교정을 시작해 드릴까요?",
      badge: { label: "Translation done", tone: "success" },
      autoStart: false,
      actions: [
        { type: "startProofread" as const, reason: "Begin proofreading" },
      ],
      stage: "translation",
    });
  }, [
    projectId,
    translationAvailable,
    translationStage,
    translationState.projectId,
    scheduleTask,
  ]);

  const maybeShareTranslationSummary = useCallback(() => {
    if (!projectId || !translationAvailable) return;
    if (translationState.projectId && translationState.projectId !== projectId)
      return;
    if (guideStateRef.current.translationSummaryShared) return;
    const summary = formatSummary(translationProfile, "번역본 요약입니다:");
    if (!summary) return;

    guideStateRef.current.translationSummaryShared = true;
    scheduleTask({
      type: "shareTranslationSummary",
      message: summary,
      badge: { label: "Translation summary", tone: "default" },
      autoStart: false,
      stage: "translation",
    });
  }, [
    projectId,
    translationAvailable,
    translationProfile,
    translationState.projectId,
    scheduleTask,
  ]);

  const maybeHandleProofreadReady = useCallback(() => {
    if (!projectId) return;
    if (
      proofreadingState.projectId &&
      proofreadingState.projectId !== projectId
    )
      return;
    const proofreadingFinished =
      proofreadingState.status === "done" || proofreadingStage === "done";
    if (!proofreadingFinished) return;
    if (guideStateRef.current.proofreadingReadyHandled) return;

    guideStateRef.current.proofreadingReadyHandled = true;
    guideStateRef.current.workflowCompleted = false;

    scheduleTask({
      type: "startQuality",
      message: "교정이 완료되었습니다. 품질 평가를 실행할까요?",
      badge: { label: "Proofreading done", tone: "success" },
      autoStart: false,
      actions: [
        { type: "startQuality" as const, reason: "Run quality assessment" },
      ],
      stage: "proofreading",
    });
  }, [
    projectId,
    proofreadingState.projectId,
    proofreadingState.status,
    proofreadingStage,
    scheduleTask,
  ]);

  const maybeHandleQualityReady = useCallback(() => {
    if (!projectId) return;
    if (qualityState.projectId && qualityState.projectId !== projectId) return;
    const qualityFinished =
      qualityState.status === "done" || qualityStage === "done";
    if (!qualityFinished) return;
    if (guideStateRef.current.workflowCompleted) return;

    guideStateRef.current.workflowCompleted = true;
    scheduleTask({
      type: "celebrateComplete",
      message:
        "품질 평가까지 완료했습니다. 필요하시면 전자책 내보내기나 추가 교정을 요청해 주세요!",
      badge: { label: "Workflow complete", tone: "success" },
      autoStart: false,
      actions: [
        { type: "viewQualityReport" as const, reason: "Review quality report" },
      ],
      stage: "quality",
    });
  }, [
    projectId,
    qualityState.projectId,
    qualityState.status,
    qualityStage,
    scheduleTask,
  ]);

  useEffect(() => {
    maybePromptMetadata();
  }, [maybePromptMetadata]);

  useEffect(() => {
    maybeGuideOrigin();
  }, [maybeGuideOrigin]);

  useEffect(() => {
    maybeShareOriginSummary();
  }, [maybeShareOriginSummary]);

  useEffect(() => {
    maybeHandleTranslationReady();
  }, [maybeHandleTranslationReady]);

  useEffect(() => {
    maybeShareTranslationSummary();
  }, [maybeShareTranslationSummary]);

  useEffect(() => {
    maybeHandleProofreadReady();
  }, [maybeHandleProofreadReady]);

  useEffect(() => {
    maybeHandleQualityReady();
  }, [maybeHandleQualityReady]);

  const handleIntent = useCallback(
    (intent: WorkflowIntent) => {
      if (!projectId) return;
      switch (intent.type) {
        case "redoTranslation":
          guideStateRef.current.translationReadyHandled = false;
          guideStateRef.current.translationSummaryShared = false;
      scheduleTask({
        type: "startTranslation",
        message:
          "요청하신 대로 번역을 다시 시작합니다. 잠시만 기다려 주세요.",
        badge: { label: "Translation redo", tone: "default" },
        actions: [
          {
            type: "startTranslation" as const,
            reason: "Restart translation",
            autoStart: true,
          },
        ],
        autoStart: true,
        payload: { mode: intent.mode ?? "full" },
      });
          break;
        case "redoProofread":
          guideStateRef.current.proofreadingReadyHandled = false;
          guideStateRef.current.workflowCompleted = false;
          scheduleTask({
            type: "startProofread",
            message:
              "교정을 다시 진행할게요. 필요한 범위를 말씀해 주셔도 좋아요.",
            badge: { label: "Proofread redo", tone: "default" },
        actions: [
          {
            type: "startProofread" as const,
            reason: "Restart proofreading",
            autoStart: true,
          },
        ],
        autoStart: true,
        payload: { mode: intent.mode ?? "quick" },
      });
          break;
        case "redoQuality":
          guideStateRef.current.workflowCompleted = false;
          scheduleTask({
            type: "startQuality",
            message: "품질 평가를 다시 수행할게요.",
            badge: { label: "Quality redo", tone: "default" },
        actions: [
          {
            type: "startQuality" as const,
            reason: "Restart quality assessment",
            autoStart: true,
          },
        ],
        autoStart: true,
        payload: { mode: intent.mode ?? "full" },
      });
          break;
        case "updateMetadata":
          guideStateRef.current.metadataPrompted = false;
          scheduleTask({
            type: "collectMetadata",
            message:
              "메타데이터를 업데이트했습니다. 다른 정보도 있으면 알려주세요.",
            badge: { label: "Metadata updated", tone: "default" },
            autoStart: false,
            payload: intent.payload,
          });
          break;
        default:
          break;
      }
    },
    [projectId, scheduleTask],
  );

  return { handleIntent };
};

export default useWorkflowGuideAgent;
