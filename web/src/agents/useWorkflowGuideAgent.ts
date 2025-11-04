import { useCallback, useEffect, useRef } from "react";
import type {
  ChatAction,
  DocumentProfileSummary,
  ProjectContent,
} from "../types/domain";
import type { ProjectContextSnapshot } from "../hooks/useProjectContext";
import { useWorkflowStore } from "../store/workflow.store";
import { useUILocale } from "../hooks/useUILocale";
import { translate } from "../lib/locale";

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
  historyReady?: boolean;
  historyGuideState?: {
    originSummaryShared?: boolean;
    translationSummaryShared?: boolean;
  };
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

const createGuideState = (projectId: string | null): GuideState => ({
  projectId,
  metadataPrompted: false,
  originSummaryPendingNotified: false,
  originSummaryShared: false,
  translationPrompted: false,
  translationReadyHandled: false,
  translationSummaryShared: false,
  proofreadingReadyHandled: false,
  workflowCompleted: false,
});

const formatSummary = (
  profile: DocumentProfileSummary | null | undefined,
  prefix: string,
) => {
  if (!profile) return null;
  const clamp = (value: string, max: number) =>
    value.length <= max ? value : `${value.slice(0, max - 1)}…`;

  const segments: string[] = [];
  const story = profile.summary?.story?.trim();
  if (story) {
    segments.push(clamp(story.replace(/\s+/g, " "), 200));
  }
  const intention = profile.summary?.intention?.trim();
  if (intention) {
    segments.push(`Intention: ${clamp(intention.replace(/\s+/g, " "), 100)}`);
  }
  const points = profile.summary?.readerPoints ?? [];
  const limitedPoints = points
    .slice(0, 3)
    .map((point) => clamp(point.replace(/\s+/g, " "), 100));
  if (limitedPoints.length) {
    segments.push(`Reader takeaways: ${limitedPoints.join("; ")}`);
  }

  if (!segments.length) return null;

  const message = `${prefix}\n${segments.join("\n")}`;
  return clamp(message, 320);
};

export const useWorkflowGuideAgent = ({
  projectId,
  snapshot,
  content,
  queueTask,
  historyReady: historyReadyProp,
  historyGuideState,
}: WorkflowGuideAgentOptions) => {
  const { locale } = useUILocale();
  const localize = useCallback(
    (
      key: string,
      fallback: string,
      params?: Record<string, string | number>,
    ) => {
      const resolved = translate(key, locale, params);
      return resolved === key ? fallback : resolved;
    },
    [locale],
  );
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

  const historyReady = historyReadyProp ?? true;
  const historyOriginSummaryShared =
    historyGuideState?.originSummaryShared ?? false;
  const historyTranslationSummaryShared =
    historyGuideState?.translationSummaryShared ?? false;

  const guideStateCacheRef = useRef<Record<string, GuideState>>({});
  const guideStateRef = useRef<GuideState>(createGuideState(projectId ?? null));

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

  useEffect(() => {
    const current = guideStateRef.current;
    if (current.projectId) {
      guideStateCacheRef.current[current.projectId] = current;
    }
    if (!projectId) {
      guideStateRef.current = createGuideState(null);
      return;
    }
    const cached = guideStateCacheRef.current[projectId];
    if (cached) {
      guideStateRef.current = cached;
    } else {
      const nextState = createGuideState(projectId);
      guideStateCacheRef.current[projectId] = nextState;
      guideStateRef.current = nextState;
    }
  }, [projectId]);

  useEffect(() => {
    if (!historyReady) return;
    if (!projectId) return;
    if (historyOriginSummaryShared) {
      guideStateRef.current.originSummaryShared = true;
      guideStateRef.current.originSummaryPendingNotified = false;
    }
    if (historyTranslationSummaryShared) {
      guideStateRef.current.translationSummaryShared = true;
    }
  }, [
    historyReady,
    historyOriginSummaryShared,
    historyTranslationSummaryShared,
    projectId,
  ]);

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
    if (needsAuthor) prompts.push("");

    scheduleTask({
      type: "collectMetadata",
      message: prompts.join(" "),
      badge: {
        label: localize("workflow_badge_metadata_needed", "Metadata needed"),
        tone: "default",
      },
      autoStart: false,
      stage: "origin",
    });
  }, [
    projectId,
    originAvailable,
    projectProfile,
    projectTitle,
    scheduleTask,
    localize,
  ]);

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
  }, [
    projectId,
    originAvailable,
    translationAvailable,
    translationState.status,
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
    }
  }, [
    projectId,
    originAvailable,
    translationAvailable,
    translationState.status,
    scheduleTranslationPrompt,
  ]);

  const maybeShareOriginSummary = useCallback(() => {
    if (!historyReady) return;
    if (!projectId || !originAvailable) return;
    if (historyOriginSummaryShared) {
      guideStateRef.current.originSummaryShared = true;
      guideStateRef.current.originSummaryPendingNotified = false;
      return;
    }
    if (!originProfile || guideStateRef.current.originSummaryShared) return;
    const summary = formatSummary(originProfile, "원작 요약입니다:");
    if (!summary) return;

    guideStateRef.current.originSummaryShared = true;
    guideStateRef.current.originSummaryPendingNotified = false;
    scheduleTask({
      type: "shareOriginSummary",
      message: summary,
      badge: {
        label: localize(
          "rightpanel_origin_summary_title",
          "Summary of manuscript",
        ),
        tone: "default",
      },
      autoStart: false,
      stage: "origin",
    });
    scheduleTranslationPrompt();
  }, [
    historyReady,
    historyOriginSummaryShared,
    projectId,
    originAvailable,
    originProfile,
    scheduleTask,
    scheduleTranslationPrompt,
    localize,
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
  }, [
    projectId,
    translationAvailable,
    translationStage,
    translationState.projectId,
  ]);

  const maybeShareTranslationSummary = useCallback(() => {
    if (!historyReady) return;
    if (!projectId || !translationAvailable) return;
    if (translationState.projectId && translationState.projectId !== projectId)
      return;
    if (historyTranslationSummaryShared) {
      guideStateRef.current.translationSummaryShared = true;
      return;
    }
    if (guideStateRef.current.translationSummaryShared) return;
    const summary = formatSummary(translationProfile, "번역본 요약입니다:");
    if (!summary) return;

    guideStateRef.current.translationSummaryShared = true;
    scheduleTask({
      type: "shareTranslationSummary",
      message: summary,
      badge: {
        label: localize(
          "rightpanel_translation_summary_title",
          "Summary of translation",
        ),
        tone: "default",
      },
      autoStart: false,
      stage: "translation",
    });
  }, [
    historyReady,
    historyTranslationSummaryShared,
    projectId,
    translationAvailable,
    translationProfile,
    translationState.projectId,
    scheduleTask,
    localize,
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
  }, [
    projectId,
    proofreadingState.projectId,
    proofreadingState.status,
    proofreadingStage,
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
        "품질 검토까지 완료했습니다. 필요하시면 전자책 내보내기나 추가 교정을 요청해 주세요!",
      badge: {
        label: localize("workflow_badge_complete", "Workflow complete"),
        tone: "success",
      },
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
    localize,
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
          break;
        case "redoProofread":
          guideStateRef.current.proofreadingReadyHandled = false;
          guideStateRef.current.workflowCompleted = false;
          break;
        case "redoQuality":
          guideStateRef.current.workflowCompleted = false;
          break;
        case "updateMetadata":
          guideStateRef.current.metadataPrompted = false;
          scheduleTask({
            type: "collectMetadata",
            message:
              "메타데이터를 업데이트했습니다. 다른 정보도 있으면 알려주세요.",
            badge: {
              label: localize(
                "workflow_badge_metadata_updated",
                "Metadata updated",
              ),
              tone: "default",
            },
            autoStart: false,
            payload: intent.payload,
          });
          break;
        default:
          break;
      }
  },
    [projectId, scheduleTask, localize],
  );

  return { handleIntent };
};

export default useWorkflowGuideAgent;
