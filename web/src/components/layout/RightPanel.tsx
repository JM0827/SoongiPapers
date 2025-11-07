import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Pencil,
  X,
  Loader2,
  CheckCircle2,
  Circle,
  BookOpen,
  AlertTriangle,
} from "lucide-react";
import { useUIStore } from "../../store/ui.store";
import type { RightPanelBaseTab, RightPanelExtraTab } from "../../store/ui.store";
import { useAuthStore } from "../../store/auth.store";
import { useAuth } from "../../hooks/useAuth";
import { useProjectStore } from "../../store/project.store";
import { ProofList } from "../proofreading/ProofList";
import { ProofreadIssuesProvider } from "../../context/ProofreadIssuesContext";
import { ProofreadEditorProvider } from "../../context/proofreadEditor";
import { ProofreadEditorTab } from "../proofreading/ProofreadEditorTab";
import { ExportPanel } from "../export/ExportPanel";
import { useUILocale } from "../../hooks/useUILocale";
import { translate } from "../../lib/locale";
import { ProjectProfileCard } from "../project/ProjectProfileCard";
import { Modal } from "../common/Modal";
import { Collapsible } from "../common/Collapsible";
import { QualityAssessmentDialog } from "../quality/QualityAssessmentDialog";
import type {
  DocumentProfileSummary,
  JobSummary,
  JobSequentialSummary,
  ProjectContent,
} from "../../types/domain";
import { api } from "../../services/api";
import {
  scopeProofreadingState,
  scopeQualityState,
  scopeTranslationState,
  useWorkflowStore,
} from "../../store/workflow.store";
import { projectKeys } from "../../hooks/useProjectData";
import {
  DocumentSummarySection,
  type SummaryStatus,
} from "../translation/DocumentSummarySection";
import { TranslationNotesEditor } from "../translation/TranslationNotesSection";
import type { LocalizeFn } from "../../types/localize";
import { UserProfileMenu } from "../userProfile/UserProfileMenu";
import type { ProjectContextSnapshot } from "../../hooks/useProjectContext";

const V2_PIPELINE_STAGE_ORDER = ["draft", "revise", "micro-check"] as const;

type PipelineStageKey = string;
type StageKey = PipelineStageKey | "finalizing";

type StageStatusKey =
  | "ready"
  | "queued"
  | "inProgress"
  | "completed"
  | "failed";

const TRANSLATION_STAGE_LABEL_META: Record<
  StageKey,
  { key: string; fallback: string }
> = {
  draft: {
    key: "translation_stage_draft",
    fallback: "Draft",
  },
  revise: {
    key: "translation_stage_revise",
    fallback: "Revise",
  },
  "micro-check": {
    key: "translation_stage_micro_check",
    fallback: "Micro-check",
  },
  finalizing: {
    key: "translation_stage_finalizing",
    fallback: "Finalizing",
  },
};

const STAGE_STATUS_META: Record<
  StageStatusKey,
  { key: string; fallback: string }
> = {
  ready: {
    key: "timeline_status_ready",
    fallback: "Ready",
  },
  queued: {
    key: "timeline_status_queued",
    fallback: "Queued",
  },
  inProgress: {
    key: "timeline_status_in_progress",
    fallback: "In Progress",
  },
  completed: {
    key: "timeline_status_completed",
    fallback: "Completed",
  },
  failed: {
    key: "timeline_status_failed",
    fallback: "Failed",
  },
};

const EXTRA_TAB_LABEL_META: Record<
  RightPanelExtraTab,
  { key: string; fallback: string }
> = {
  profile: {
    key: "rightpanel_tab_profile",
    fallback: "My profile",
  },
  settings: {
    key: "rightpanel_tab_settings",
    fallback: "My settings",
  },
  activity: {
    key: "rightpanel_tab_activity",
    fallback: "My activity",
  },
  terms: {
    key: "rightpanel_tab_terms",
    fallback: "Terms",
  },
  privacy: {
    key: "rightpanel_tab_privacy",
    fallback: "Privacy",
  },
};

const applyParams = (
  template: string,
  params?: Record<string, string | number>,
): string => {
  if (!params) return template;
  return template.replace(/{{(\w+)}}/g, (match, token) => {
    if (Object.prototype.hasOwnProperty.call(params, token)) {
      return String(params[token]);
    }
    return match;
  });
};

const getPipelineStageOrder = (
  sequential?: JobSequentialSummary | null,
): string[] => {
  if (sequential?.pipelineStages?.length) {
    return sequential.pipelineStages;
  }
  return Array.from(V2_PIPELINE_STAGE_ORDER);
};

const inferCurrentPipelineStage = (
  sequential: JobSequentialSummary,
): PipelineStageKey | null => {
  if (!sequential.totalSegments) return null;
  const stageOrder = getPipelineStageOrder(sequential);
  if (sequential.currentStage) {
    const normalized = sequential.currentStage.toLowerCase();
    if (stageOrder.includes(normalized)) {
      return normalized as PipelineStageKey;
    }
  }
  return (
    stageOrder.find((stage) => {
      const count = sequential.stageCounts?.[stage] ?? 0;
      return count < sequential.totalSegments;
    }) ?? stageOrder[stageOrder.length - 1]
  );
};

const resolveStageStatusKey = (
  job: JobSummary,
  stageKey: StageKey,
  sequential: JobSequentialSummary,
  total: number,
): StageStatusKey => {
  const normalizedJobStatus = job.status?.toLowerCase() ?? "";
  const translationDone =
    normalizedJobStatus === "done" ||
    normalizedJobStatus === "succeeded" ||
    normalizedJobStatus === "completed" ||
    normalizedJobStatus === "success" ||
    Boolean(job.finalTranslation);
  const currentStage = inferCurrentPipelineStage(sequential);
  const completedStages = new Set(
    (sequential.completedStages ?? []).map((stage) => stage.toLowerCase()),
  );
  const stageCount = sequential.stageCounts?.[stageKey] ?? 0;
  const pipelineStageCount = sequential.stageCounts ?? {};
  const stageOrder = getPipelineStageOrder(sequential);
  const guardStageKey = stageOrder.includes("micro-check")
    ? "micro-check"
    : stageOrder[stageOrder.length - 1] ?? "micro-check";
  const guardCount = pipelineStageCount[guardStageKey] ?? 0;
  const qaComplete =
    total > 0 ? guardCount >= total : completedStages.has(guardStageKey);

  if (stageKey === "finalizing") {
    if (
      normalizedJobStatus === "failed" ||
      normalizedJobStatus === "cancelled"
    ) {
      return "failed";
    }
    if (completedStages.has("finalizing") || translationDone) {
      return "completed";
    }
    if (qaComplete) {
      return normalizedJobStatus === "running" ? "inProgress" : "ready";
    }
    return "queued";
  }

  const completed = total > 0 && stageCount >= total;

  if (completed || completedStages.has(stageKey)) {
    return "completed";
  }

  if (normalizedJobStatus === "failed" || normalizedJobStatus === "cancelled") {
    if (currentStage === stageKey || (!currentStage && stageCount < total)) {
      return "failed";
    }
    return "queued";
  }

  if (currentStage === stageKey) {
    if (normalizedJobStatus === "queued" || normalizedJobStatus === "pending") {
      return "queued";
    }
    return "inProgress";
  }

  const stageIndex = stageOrder.indexOf(stageKey);
  const currentIndex = currentStage ? stageOrder.indexOf(currentStage) : -1;

  if (currentIndex >= 0) {
    if (stageIndex < currentIndex) {
      return "completed";
    }
    if (stageIndex === currentIndex + 1) {
      return normalizedJobStatus === "running" ? "ready" : "queued";
    }
    if (stageIndex > currentIndex + 1) {
      return "queued";
    }
  } else {
    if (normalizedJobStatus === "queued" || normalizedJobStatus === "pending") {
      return "queued";
    }
    if (normalizedJobStatus === "running") {
      if (stageIndex === 0) {
        return "inProgress";
      }
      const previousStage = stageOrder[stageIndex - 1];
      const previousComplete =
        (sequential.stageCounts?.[previousStage] ?? 0) >= total ||
        completedStages.has(previousStage);
      return previousComplete ? "ready" : "queued";
    }
    if (
      normalizedJobStatus === "succeeded" ||
      normalizedJobStatus === "completed"
    ) {
      return "completed";
    }
  }

  return stageCount > 0 ? "inProgress" : "queued";
};

const formatSequentialStageStatus = (
  job: JobSummary,
  localize: LocalizeFn,
): string | null => {
  const sequential = job.sequential;
  if (!sequential || !sequential.totalSegments) {
    return null;
  }
  const total = sequential.totalSegments;
  const normalizedJobStatus = job.status?.toLowerCase() ?? "";
  const pipelineStage = inferCurrentPipelineStage(sequential);
  const completedStages = new Set(
    (sequential.completedStages ?? []).map((stage) => stage.toLowerCase()),
  );
  const stageOrder = getPipelineStageOrder(sequential);
  const guardStageKey = stageOrder.includes("micro-check")
    ? "micro-check"
    : stageOrder[stageOrder.length - 1] ?? "micro-check";
  const qaCount = sequential.stageCounts?.[guardStageKey] ?? 0;
  const qaComplete =
    total > 0 ? qaCount >= total : completedStages.has(guardStageKey);
  const translationDone =
    normalizedJobStatus === "done" ||
    normalizedJobStatus === "succeeded" ||
    normalizedJobStatus === "completed" ||
    normalizedJobStatus === "success" ||
    Boolean(job.finalTranslation);

  const stageKey: StageKey = (() => {
    if (
      (qaComplete &&
        normalizedJobStatus !== "failed" &&
        normalizedJobStatus !== "cancelled" &&
        !translationDone) ||
      translationDone
    ) {
      return "finalizing";
    }
    if (pipelineStage) {
      return pipelineStage;
    }
    return stageOrder[stageOrder.length - 1];
  })();
  const stageMeta = TRANSLATION_STAGE_LABEL_META[stageKey] ?? {
    key: stageKey,
    fallback: stageKey,
  };
  const stageLabel = localize(stageMeta.key, stageMeta.fallback);
  const completedSegments = Math.min(
    sequential.stageCounts?.[stageKey] ?? 0,
    total,
  );
  const statusKey = resolveStageStatusKey(job, stageKey, sequential, total);
  const statusMeta = STAGE_STATUS_META[statusKey];
  const statusLabel = localize(statusMeta.key, statusMeta.fallback);

  if (stageKey === "finalizing") {
    return localize(
      "rightpanel_job_stage_finalizing",
      "Job {{jobId}} · {{stageLabel}} ({{statusLabel}})",
      {
        jobId: job.id,
        stageLabel,
        statusLabel,
      },
    );
  }

  return localize(
    "rightpanel_job_stage_progress",
    "Job {{jobId}} · {{stageLabel}} ({{statusLabel}}) {{completed}}/{{total}}",
    {
      jobId: job.id,
      stageLabel,
      statusLabel,
      completed: completedSegments,
      total,
    },
  );
};

interface RightPanelProps {
  content?: ProjectContent | null;
  isContentLoading?: boolean;
  jobs?: JobSummary[] | null;
  isJobsLoading?: boolean;
  onProfileUpdated?: () => void;
  onRefreshContent?: () => Promise<void> | void;
  snapshot: ProjectContextSnapshot;
}

export const RightPanel = ({
  content,
  isContentLoading,
  jobs: jobsProp = [],
  isJobsLoading = false,
  onProfileUpdated,
  onRefreshContent,
  snapshot,
}: RightPanelProps) => {
  const queryClient = useQueryClient();
  const activeTab = useUIStore((state) => state.rightPanelTab);
  const setTab = useUIStore((state) => state.setRightPanelTab);
  const extraTab = useUIStore((state) => state.extraTab);
  const openExtraTab = useUIStore((state) => state.openExtraTab);
  const clearExtraTab = useUIStore((state) => state.clearExtraTab);
  const qualityDialogOpen = useUIStore((state) => state.qualityDialogOpen);
  const closeQualityDialog = useUIStore((state) => state.closeQualityDialog);
  const advancedProofreadEnabled = useUIStore(
    (state) => state.advancedProofreadEnabled,
  );
  const setAdvancedProofreadEnabled = useUIStore(
    (state) => state.setAdvancedProofreadEnabled,
  );
  const toggleAdvancedProofread = useUIStore(
    (state) => state.toggleAdvancedProofread,
  );
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileControls, setProfileControls] = useState<{
    isEditing: boolean;
    startEdit: () => void;
  } | null>(null);
  const previousProofStageRef = useRef<string | null>(null);
  const user = useAuthStore((state) => state.user);
  const token = useAuthStore((state) => state.token);
  const { logout } = useAuth();
  const activeProjectId = useProjectStore((state) => state.activeProjectId);
  const projects = useProjectStore((state) => state.projects);
  const previousProjectRef = useRef<string | null>(activeProjectId ?? null);
  const { locale, setLocale } = useUILocale();

  const localize = useCallback(
    (
      key: string,
      fallback: string,
      params?: Record<string, string | number>,
    ) => {
      const resolved = translate(key, locale, params);
      if (resolved === key) {
        return applyParams(fallback, params);
      }
      return resolved;
    },
    [locale],
  );

  const projectJobs = useMemo<JobSummary[]>(
    () => (Array.isArray(jobsProp) ? jobsProp : []),
    [jobsProp],
  );

  const resolvedExtraTabLabel = useMemo(() => {
    if (!extraTab) return null;
    const meta = EXTRA_TAB_LABEL_META[extraTab.key];
    if (!meta) {
      return extraTab.label;
    }
    return localize(meta.key, meta.fallback);
  }, [extraTab, localize]);

  const [careerSummary, setCareerSummary] = useState("");
  const [careerSavedAt, setCareerSavedAt] = useState<string | null>(null);
  const [settingsState, setSettingsState] = useState({
    emailUpdates: true,
    pushNotifications: false,
    locale: locale,
    tokenAlerts: true,
    theme: "system" as "system" | "light" | "dark",
  });
  const [isNotesModalOpen, setNotesModalOpen] = useState(false);
  const [isOriginModalOpen, setOriginModalOpen] = useState(false);
  const [isTranslationModalOpen, setTranslationModalOpen] = useState(false);
  const [profileStatus, setProfileStatus] = useState<{
    consent: boolean;
    requiredFilled: boolean;
    complete: boolean;
  } | null>(null);
  const profileStatusCacheRef = useRef<
    Record<
      string,
      { consent: boolean; requiredFilled: boolean; complete: boolean }
    >
  >({});

  const handleProfileStatusChange = useCallback(
    (status: {
      consent: boolean;
      requiredFilled: boolean;
      complete: boolean;
    }) => {
      if (!activeProjectId) {
        setProfileStatus(status);
        return;
      }
      const previous = profileStatusCacheRef.current[activeProjectId] ?? null;
      if (
        previous &&
        previous.consent === status.consent &&
        previous.requiredFilled === status.requiredFilled &&
        previous.complete === status.complete
      ) {
        return;
      }
      profileStatusCacheRef.current[activeProjectId] = status;
      setProfileStatus(status);
    },
    [activeProjectId],
  );

  const [settingsSavedAt, setSettingsSavedAt] = useState<string | null>(null);
  const [isSavingTranslationNotes, setSavingTranslationNotes] = useState(false);
  const [translationNotesError, setTranslationNotesError] = useState<
    string | null
  >(null);
  const handleOpenNotesModal = useCallback(() => {
    setTranslationNotesError(null);
    setNotesModalOpen(true);
  }, []);

  const handleCloseNotesModal = useCallback(() => {
    if (isSavingTranslationNotes) return;
    setNotesModalOpen(false);
    setTranslationNotesError(null);
  }, [isSavingTranslationNotes]);

  const [isReanalyzingOrigin, setReanalyzingOrigin] = useState(false);
  const [reanalyzeError, setReanalyzeError] = useState<string | null>(null);

  useEffect(() => {
    setTranslationNotesError(null);
    setSavingTranslationNotes(false);
  }, [activeProjectId]);

  useEffect(() => {
    setNotesModalOpen(false);
  }, [activeProjectId]);

  useEffect(() => {
    setReanalyzingOrigin(false);
    setReanalyzeError(null);
  }, [activeProjectId]);

  useEffect(() => {
    setOriginModalOpen(false);
    setTranslationModalOpen(false);
  }, [activeProjectId]);

  useEffect(() => {
    if (!activeProjectId) {
      setProfileStatus(null);
      return;
    }
    const cached = profileStatusCacheRef.current[activeProjectId];
    setProfileStatus(cached ?? null);
  }, [activeProjectId]);

  const projectSummary = useMemo(
    () =>
      projects.find((project) => project.project_id === activeProjectId) ??
      null,
    [projects, activeProjectId],
  );

  const profileStatusIcon = useMemo(() => {
    if (!profileStatus) {
      return (
        <Loader2
          className="h-4 w-4 animate-spin text-slate-400"
          aria-hidden="true"
        />
      );
    }
    if (profileStatus.complete) {
      return (
        <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden="true" />
      );
    }
    return <Circle className="h-4 w-4 text-rose-500" aria-hidden="true" />;
  }, [profileStatus]);

  const profileNeedsAttention = profileStatus ? !profileStatus.complete : false;
  const profileAttentionLabel = localize(
    "rightpanel_preview_profile_incomplete_badge",
    "Fix",
  );
  const profileAttentionHint = localize(
    "rightpanel_preview_profile_incomplete_hint",
    "Complete the profile to proceed.",
  );

  const profileActionNode =
    profileNeedsAttention || (profileControls && !profileControls.isEditing) ? (
      <div className="flex items-center gap-2">
        {profileNeedsAttention ? (
          <button
            type="button"
            onClick={() => setProfileOpen(true)}
            className="flex items-center gap-1 rounded bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-200 transition hover:bg-amber-100"
            title={profileAttentionHint}
            aria-label={profileAttentionHint}
            data-collapsible-ignore
          >
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{profileAttentionLabel}</span>
          </button>
        ) : null}
        {profileControls && !profileControls.isEditing ? (
          <button
            type="button"
            onClick={() => {
              if (!profileOpen) {
                setProfileOpen(true);
              }
              profileControls.startEdit();
            }}
            className="flex h-6 w-6 items-center justify-center rounded text-slate-500 transition hover:text-slate-700"
            aria-label={localize(
              "rightpanel_preview_profile_edit",
              "Edit profile",
            )}
            title={localize("rightpanel_preview_profile_edit", "Edit profile")}
            data-collapsible-ignore
          >
            <Pencil className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>
    ) : undefined;

  const appliedTranslation = content?.proofreading?.appliedTranslation ?? null;
  const originPrepSnapshot = content?.originPrep ?? null;
  const canManuallyRefreshOrigin = Boolean(
    token &&
      content?.projectId &&
      originPrepSnapshot &&
      originPrepSnapshot.upload.status === "uploaded",
  );
  const canTriggerReanalysis = Boolean(
    canManuallyRefreshOrigin &&
      originPrepSnapshot?.analysis.status !== "running",
  );

  const snapshotOriginFilename = snapshot.origin?.filename ?? null;

  const originFilename = useMemo(() => {
    const originMeta = content?.content?.origin;
    if (!originMeta) return undefined;
    if (
      typeof originMeta.filename === "string" &&
      originMeta.filename.length > 0
    ) {
      return originMeta.filename;
    }
    const camel = (originMeta as { fileName?: string | null }).fileName;
    if (typeof camel === "string" && camel.length > 0) {
      return camel;
    }
    const legacy = originMeta as { original_filename?: string | null };
    if (
      typeof legacy.original_filename === "string" &&
      legacy.original_filename.length > 0
    ) {
      return legacy.original_filename;
    }
    const snapshotName = snapshotOriginFilename;
    if (typeof snapshotName === "string" && snapshotName.length > 0) {
      return snapshotName;
    }
    return undefined;
  }, [content, snapshotOriginFilename]);

  const handleReanalyzeOrigin = useCallback(async () => {
    if (!token || !content?.projectId) return;
    setReanalyzingOrigin(true);
    setReanalyzeError(null);
    try {
      await api.retryOriginAnalysis(token, content.projectId);
      await queryClient.invalidateQueries({
        queryKey: projectKeys.content(content.projectId),
        exact: true,
      });
      await onRefreshContent?.();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : localize("origin_prep_refresh_error", "Failed to re-run analysis.");
      setReanalyzeError(message);
    } finally {
      setReanalyzingOrigin(false);
    }
  }, [token, content?.projectId, queryClient, onRefreshContent, localize]);

  const translationAgentStateRaw = useWorkflowStore((state) => state.translation);
  const proofreadingAgentStateRaw = useWorkflowStore(
    (state) => state.proofreading,
  );
  const translationAgentState = useMemo(
    () => scopeTranslationState(translationAgentStateRaw, snapshot.projectId ?? null),
    [snapshot.projectId, translationAgentStateRaw],
  );
  const proofreadingAgentState = useMemo(
    () => scopeProofreadingState(proofreadingAgentStateRaw, snapshot.projectId ?? null),
    [snapshot.projectId, proofreadingAgentStateRaw],
  );

  const resolvedTabs = useMemo<
    Array<{ key: RightPanelBaseTab; label: string }>
  >(() => {
    const tabs: Array<{ key: RightPanelBaseTab; label: string }> = [
      {
        key: "preview",
        label: localize("rightpanel_tab_overview", "Overview"),
      },
      {
        key: "proofread:editing",
        label: localize("rightpanel_tab_editor", "Editor"),
      },
    ];
    if (advancedProofreadEnabled) {
      tabs.push({
        key: "proofread:findings",
        label: localize("rightpanel_tab_finder", "Proofread"),
      });
    }
    tabs.push({
      key: "export",
      label: localize("rightpanel_tab_export", "eBook"),
    });
    return tabs;
  }, [advancedProofreadEnabled, localize]);

  const prevAdvancedRef = useRef(advancedProofreadEnabled);

  useEffect(() => {
    if (!prevAdvancedRef.current && advancedProofreadEnabled) {
      setTab("proofread:findings");
    } else if (
      prevAdvancedRef.current &&
      !advancedProofreadEnabled &&
      activeTab === "proofread:findings"
    ) {
      setTab("proofread:editing");
    }
    prevAdvancedRef.current = advancedProofreadEnabled;
  }, [advancedProofreadEnabled, activeTab, setTab]);

  const handleAdvancedProofreadToggle = useCallback(() => {
    toggleAdvancedProofread();
  }, [toggleAdvancedProofread]);

  const originProfile = content?.documentProfiles?.origin ?? null;
  const translationProfile = content?.documentProfiles?.translation ?? null;
  const originContentAvailable = Boolean(
    content?.content?.origin?.content?.trim().length,
  );
  const translationContentFromBatches = useMemo(() => {
    const batches = content?.content?.batchesActualData;
    if (!Array.isArray(batches) || !batches.length) return null;
    const fragments = batches
      .map((batch) => {
        if (!batch) return "";
        const candidate =
          (batch as { translated_text?: unknown; translatedText?: unknown })
            .translated_text ??
          (batch as { translated_text?: unknown; translatedText?: unknown })
            .translatedText ??
          null;
        return typeof candidate === "string" ? candidate.trim() : "";
      })
      .filter((fragment) => fragment.length > 0);
    if (!fragments.length) return null;
    return fragments.join("\n\n");
  }, [content?.content?.batchesActualData]);

  const translationText = useMemo(() => {
    const translationMeta = content?.content?.translation;
    const primary = translationMeta?.content;
    if (typeof primary === "string" && primary.length > 0) {
      return primary;
    }
    if (
      typeof appliedTranslation === "string" &&
      appliedTranslation.length > 0
    ) {
      return appliedTranslation;
    }
    if (typeof translationContentFromBatches === "string") {
      return translationContentFromBatches;
    }
    return "";
  }, [content, appliedTranslation, translationContentFromBatches]);
  const translationContentAvailable = Boolean(
    content?.content?.translation?.content?.trim().length ||
      translationContentFromBatches?.trim().length ||
      appliedTranslation?.trim?.().length,
  );

  const originText = content?.content?.origin?.content ?? "";
  const originTitle =
    content?.projectProfile?.bookTitle ??
    projectSummary?.book_title ??
    content?.projectProfile?.title ??
    projectSummary?.title ??
    "";
  const originAuthor =
    content?.projectProfile?.meta?.author ??
    content?.projectProfile?.authorName ??
    projectSummary?.author_name ??
    "";

  const originFallback = useMemo(() => {
    if (originProfile || !originContentAvailable) return null;
    const raw = originText;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const paragraphs = trimmed
      .split(/\n{2,}/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    const preview = paragraphs.length
      ? paragraphs.slice(0, 2).join("\n\n")
      : trimmed.slice(0, 600);
    const previewLimited =
      preview.length > 600 ? `${preview.slice(0, 600)}…` : preview;
    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    const charCount = trimmed.length;
    const paragraphCount = paragraphs.length || 1;
    const readingTimeMinutes = Number((wordCount / 220).toFixed(2));

    return {
      summary: {
        story: previewLimited,
        intention: null,
        readerPoints: [] as string[],
      },
      metrics: {
        wordCount,
        charCount,
        paragraphCount,
        readingTimeMinutes,
        readingTimeLabel: "",
      },
      timestamp: content?.content?.origin?.timestamp ?? null,
      language:
        content?.content?.origin?.language ??
        (content?.content?.origin as { lang?: string } | undefined)?.lang ??
        null,
    };
  }, [
    content?.content?.origin,
    originContentAvailable,
    originProfile,
    originText,
  ]);

  const originSummaryStatus: SummaryStatus = originProfile
    ? "done"
    : originContentAvailable
      ? "done"
      : "pending";

  const translationSummaryStatus: SummaryStatus = translationProfile
    ? "done"
    : translationAgentState.status === "running" ||
        translationAgentState.status === "queued"
      ? "running"
      : translationAgentState.status === "failed"
        ? "pending"
        : translationContentAvailable
          ? "done"
          : "pending";

  const originMetrics = useMemo(() => {
    if (originProfile?.metrics) return originProfile.metrics;
    if (originFallback?.metrics) return originFallback.metrics;
    if (!originContentAvailable) return null;
    const trimmed = originText.trim();
    if (!trimmed) return null;
    const words = trimmed.split(/\s+/).filter(Boolean).length;
    const chars = trimmed.length;
    const paragraphs = trimmed
      .split(/\n{2,}/)
      .map((segment) => segment.trim())
      .filter(Boolean).length;
    const readingTimeMinutes = Number((words / 220).toFixed(2));
    return {
      wordCount: words,
      charCount: chars,
      paragraphCount: paragraphs || 1,
      readingTimeMinutes,
      readingTimeLabel: "",
    };
  }, [originProfile, originFallback, originContentAvailable, originText]);

  const originMetricLabels = useMemo(() => {
    if (!originMetrics) return [] as string[];
    const labels: string[] = [];
    if (
      typeof originMetrics.wordCount === "number" &&
      Number.isFinite(originMetrics.wordCount)
    ) {
      const formatted = Number(originMetrics.wordCount).toLocaleString();
      labels.push(
        localize("rightpanel_summary_metric_words", `${formatted} words`, {
          count: formatted,
        }),
      );
    }
    if (
      typeof originMetrics.charCount === "number" &&
      Number.isFinite(originMetrics.charCount)
    ) {
      const formatted = Number(originMetrics.charCount).toLocaleString();
      labels.push(
        localize(
          "rightpanel_summary_metric_characters",
          `${formatted} characters`,
          {
            count: formatted,
          },
        ),
      );
    }
    if (
      typeof originMetrics.readingTimeMinutes === "number" &&
      Number.isFinite(originMetrics.readingTimeMinutes)
    ) {
      const minutes = Math.max(
        1,
        Math.round(originMetrics.readingTimeMinutes),
      ).toString();
      labels.push(
        localize("rightpanel_summary_metric_minutes", `${minutes} mins`, {
          count: minutes,
        }),
      );
    }
    return labels;
  }, [originMetrics, localize]);

  const originTimestampRaw =
    originProfile?.updatedAt ??
    originProfile?.createdAt ??
    content?.content?.origin?.timestamp ??
    originFallback?.timestamp ??
    null;

  const originTimestampLabel = useMemo(() => {
    if (!originTimestampRaw) return null;
    const parsed = Date.parse(originTimestampRaw);
    if (Number.isNaN(parsed)) return null;
    return new Date(parsed).toLocaleString();
  }, [originTimestampRaw]);

  const handleOpenOriginModal = useCallback(() => {
    if (!originContentAvailable) return;
    setOriginModalOpen(true);
  }, [originContentAvailable]);

  const handleCloseOriginModal = useCallback(() => {
    setOriginModalOpen(false);
  }, []);

  const originSummaryAccessory = useMemo(() => {
    const label = localize(
      "rightpanel_origin_open_full",
      "View full manuscript",
    );
    return (
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!originContentAvailable) return;
          handleOpenOriginModal();
        }}
        className={`flex h-7 w-7 items-center justify-center rounded text-sm transition ${
          originContentAvailable
            ? "text-slate-500 hover:bg-indigo-50 hover:text-indigo-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            : "cursor-not-allowed text-slate-300"
        }`}
        title={label}
        aria-label={label}
        data-collapsible-ignore
        disabled={!originContentAvailable}
      >
        <BookOpen className="h-4 w-4" aria-hidden="true" />
      </button>
    );
  }, [originContentAvailable, handleOpenOriginModal, localize]);
  const translationFallback = useMemo(() => {
    if (translationProfile) return null;
    const primary = content?.content?.translation?.content ?? "";
    const source =
      appliedTranslation && appliedTranslation.trim().length
        ? appliedTranslation
        : primary.trim().length
          ? primary
          : (translationContentFromBatches ?? "");
    const trimmed = source.trim();
    if (!trimmed) return null;
    const paragraphs = trimmed
      .split(/\n{2,}/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    const preview = paragraphs.length
      ? paragraphs.slice(0, 2).join("\n\n")
      : trimmed.slice(0, 600);
    const previewLimited =
      preview.length > 600 ? `${preview.slice(0, 600)}…` : preview;
    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    const charCount = trimmed.length;
    const paragraphCount = paragraphs.length || 1;
    const readingTimeMinutes = Number((wordCount / 220).toFixed(2));

    return {
      summary: {
        story: previewLimited,
        intention: null,
        readerPoints: [] as string[],
      },
      metrics: {
        wordCount,
        charCount,
        paragraphCount,
        readingTimeMinutes,
        readingTimeLabel: "",
      },
      timestamp:
        content?.content?.translation?.timestamp ??
        content?.proofreading?.updatedAt ??
        null,
      language:
        content?.content?.translation?.language ??
        (content?.content?.translation as { lang?: string } | undefined)
          ?.lang ??
        null,
    };
  }, [
    content?.content?.translation,
    content?.proofreading?.updatedAt,
    translationContentFromBatches,
    translationProfile,
    appliedTranslation,
  ]);

  const translationMetrics = useMemo(() => {
    if (translationProfile?.metrics) return translationProfile.metrics;
    if (translationFallback?.metrics) return translationFallback.metrics;
    if (!translationContentAvailable) return null;
    const trimmed = translationText.trim();
    if (!trimmed) return null;
    const words = trimmed.split(/\s+/).filter(Boolean).length;
    const chars = trimmed.length;
    const paragraphs = trimmed
      .split(/\n{2,}/)
      .map((segment) => segment.trim())
      .filter(Boolean).length;
    const readingTimeMinutes = Number((words / 220).toFixed(2));
    return {
      wordCount: words,
      charCount: chars,
      paragraphCount: paragraphs || 1,
      readingTimeMinutes,
      readingTimeLabel: "",
    };
  }, [
    translationProfile,
    translationFallback,
    translationContentAvailable,
    translationText,
  ]);

  const translationMetricLabels = useMemo(() => {
    if (!translationMetrics) return [] as string[];
    const labels: string[] = [];
    if (
      typeof translationMetrics.wordCount === "number" &&
      Number.isFinite(translationMetrics.wordCount)
    ) {
      const formatted = Number(translationMetrics.wordCount).toLocaleString();
      labels.push(
        localize("rightpanel_summary_metric_words", `${formatted} words`, {
          count: formatted,
        }),
      );
    }
    if (
      typeof translationMetrics.charCount === "number" &&
      Number.isFinite(translationMetrics.charCount)
    ) {
      const formatted = Number(translationMetrics.charCount).toLocaleString();
      labels.push(
        localize(
          "rightpanel_summary_metric_characters",
          `${formatted} characters`,
          {
            count: formatted,
          },
        ),
      );
    }
    if (
      typeof translationMetrics.readingTimeMinutes === "number" &&
      Number.isFinite(translationMetrics.readingTimeMinutes)
    ) {
      const minutes = Math.max(
        1,
        Math.round(translationMetrics.readingTimeMinutes),
      ).toString();
      labels.push(
        localize("rightpanel_summary_metric_minutes", `${minutes} mins`, {
          count: minutes,
        }),
      );
    }
    return labels;
  }, [translationMetrics, localize]);

  const translationTimestampRaw =
    translationProfile?.updatedAt ??
    translationProfile?.createdAt ??
    content?.content?.translation?.timestamp ??
    translationFallback?.timestamp ??
    null;

  const translationTimestampLabel = useMemo(() => {
    if (!translationTimestampRaw) return null;
    const parsed = Date.parse(translationTimestampRaw);
    if (Number.isNaN(parsed)) return null;
    return new Date(parsed).toLocaleString();
  }, [translationTimestampRaw]);

  const translationTitle =
    content?.projectProfile?.meta?.bookTitleEn ??
    content?.projectProfile?.bookTitle ??
    projectSummary?.title ??
    "";

  const translationAuthor =
    content?.projectProfile?.translatorName ??
    content?.projectProfile?.meta?.translator ??
    projectSummary?.translator_name ??
    "";

  const translationModalText = useMemo(() => {
    if (translationText.trim().length) return translationText;
    const fallbackStory = translationFallback?.summary?.story ?? "";
    return fallbackStory;
  }, [translationText, translationFallback]);

  const handleOpenTranslationModal = useCallback(() => {
    if (!translationContentAvailable && !translationFallback) return;
    setTranslationModalOpen(true);
  }, [translationContentAvailable, translationFallback]);

  const handleCloseTranslationModal = useCallback(() => {
    setTranslationModalOpen(false);
  }, []);

  const translationSummaryAccessory = useMemo(() => {
    const label = localize(
      "rightpanel_translation_open_full",
      "View full translation",
    );
    return (
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!translationContentAvailable && !translationFallback) return;
          handleOpenTranslationModal();
        }}
        className={`flex h-7 w-7 items-center justify-center rounded text-sm transition ${
          translationContentAvailable || translationFallback
            ? "text-slate-500 hover:bg-indigo-50 hover:text-indigo-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            : "cursor-not-allowed text-slate-300"
        }`}
        title={label}
        aria-label={label}
        data-collapsible-ignore
        disabled={!translationContentAvailable && !translationFallback}
      >
        <BookOpen className="h-4 w-4" aria-hidden="true" />
      </button>
    );
  }, [
    translationContentAvailable,
    translationFallback,
    handleOpenTranslationModal,
    localize,
  ]);

  const serverProofreadingStage = useMemo(() => {
    const proofMeta = content?.proofreading;
    return (
      content?.proofreadingStage ??
      proofMeta?.stage ??
      (proofMeta as { status?: string | null } | null)?.status ??
      null
    );
  }, [content]);

  const translationRefreshAttemptsRef = useRef(0);

  useEffect(() => {
    if (translationSummaryStatus !== "done") {
      translationRefreshAttemptsRef.current = 0;
      return;
    }
    const hasText =
      Boolean(translationContentAvailable) || Boolean(translationFallback);
    if (hasText || !onRefreshContent) {
      translationRefreshAttemptsRef.current = 0;
      return;
    }
    if (translationRefreshAttemptsRef.current >= 6) {
      return;
    }
    translationRefreshAttemptsRef.current += 1;
    const delay = 1000 * translationRefreshAttemptsRef.current;
    const timeoutId = window.setTimeout(() => {
      void onRefreshContent();
    }, delay);
    return () => window.clearTimeout(timeoutId);
  }, [
    translationSummaryStatus,
    translationContentAvailable,
    translationFallback,
    onRefreshContent,
  ]);

  const handleRefreshContent = useCallback(async () => {
    if (onRefreshContent) {
      await onRefreshContent();
    }
  }, [onRefreshContent]);

  const shouldPollProofreading = useMemo(() => {
    const normalized = serverProofreadingStage?.toString().toLowerCase() ?? "";
    if (!normalized) return false;
    return ["running", "queued", "in-progress", "inprogress"].some((state) =>
      normalized.includes(state),
    );
  }, [serverProofreadingStage]);

  useEffect(() => {
    if (typeof window === "undefined" || !shouldPollProofreading)
      return undefined;

    const intervalId = window.setInterval(() => {
      void handleRefreshContent();
    }, 5000);

    return () => window.clearInterval(intervalId);
  }, [shouldPollProofreading, handleRefreshContent]);

  useEffect(() => {
    const previous = previousProofStageRef.current?.toLowerCase() ?? null;
    const current = serverProofreadingStage?.toString().toLowerCase() ?? null;
    previousProofStageRef.current = serverProofreadingStage ?? null;

    const isCompleted = current
      ? ["done", "completed", "complete", "finished"].some((state) =>
          current.includes(state),
        )
      : false;
    const wasCompleted = previous
      ? ["done", "completed", "complete", "finished"].some((state) =>
          previous.includes(state),
        )
      : false;

    if (isCompleted && !wasCompleted) {
      void handleRefreshContent();
    }
  }, [serverProofreadingStage, handleRefreshContent]);

  const handleSaveTranslationNotes = useCallback(
    async (nextNotes: DocumentProfileSummary["translationNotes"] | null) => {
      if (!token || !activeProjectId) {
        throw new Error("로그인 상태를 확인해 주세요.");
      }
      setTranslationNotesError(null);
      setSavingTranslationNotes(true);
      try {
        await api.updateTranslationNotes(token, activeProjectId, {
          translationNotes: nextNotes,
        });
        await handleRefreshContent();
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : "번역 노트를 저장하지 못했습니다.";
        setTranslationNotesError(message);
        throw err;
      } finally {
        setSavingTranslationNotes(false);
      }
    },
    [token, activeProjectId, handleRefreshContent],
  );

  const avatarInitial =
    user?.name?.trim()?.charAt(0)?.toUpperCase() ??
    projectSummary?.title?.trim()?.charAt(0)?.toUpperCase() ??
    null;
  const avatarTone = useMemo(() => {
    const seed = user?.id ?? projectSummary?.project_id ?? null;
    if (!seed) return "bg-indigo-500";
    const palette = [
      "bg-indigo-500",
      "bg-emerald-500",
      "bg-amber-500",
      "bg-rose-500",
      "bg-slate-600",
    ];
    const hash = seed
      .split("")
      .reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return palette[hash % palette.length];
  }, [user?.id, projectSummary?.project_id]);
  const activityEntries = useMemo(() => {
    type ActivityEntry = { timestamp: string; label: string };
    const entries: ActivityEntry[] = [];
    const pushEntry = (timestamp?: string | null, label?: string) => {
      if (!timestamp || !label) return;
      const parsed = new Date(timestamp);
      if (Number.isNaN(parsed.getTime())) return;
      entries.push({ timestamp: parsed.toISOString(), label });
    };

    pushEntry(projectSummary?.created_at ?? null, "Project created");
    pushEntry(projectSummary?.updated_at ?? null, "Project updated");

    if (content?.content?.origin?.timestamp) {
      pushEntry(content.content.origin.timestamp, "Origin manuscript uploaded");
    }
    if (content?.content?.translation?.timestamp) {
      pushEntry(content.content.translation.timestamp, "Translation compiled");
    }
    if (content?.latestJob?.createdAt) {
      pushEntry(
        content.latestJob.createdAt,
        `Job ${content.latestJob.jobId} created`,
      );
    }
    if (content?.latestJob?.updatedAt) {
      pushEntry(
        content.latestJob.updatedAt,
        `Job ${content.latestJob.jobId} ${content.latestJob.status.toLowerCase()}`,
      );
    }
    if (content?.qualityAssessment?.timestamp) {
      pushEntry(
        content.qualityAssessment.timestamp,
        "Quality assessment completed",
      );
    }
    if (content?.proofreading?.timestamp) {
      pushEntry(
        content.proofreading.timestamp,
        content.proofreading.applied
          ? "Proofreading applied to translation"
          : "Proofreading results available",
      );
    }

    content?.content?.batchesMetadata?.forEach((batch) => {
      pushEntry(
        batch.startedAt,
        `Batch #${batch.index + 1} processing started`,
      );
      pushEntry(
        batch.finishedAt,
        `Batch #${batch.index + 1} processing finished`,
      );
    });

    projectJobs.forEach((job) => {
      pushEntry(
        job.created_at ?? null,
        `${job.type === "translate" ? "Translation" : "Analysis"} job ${job.id} queued`,
      );
      const sequentialStatus = formatSequentialStageStatus(job, localize);
      const statusLabel = sequentialStatus
        ? sequentialStatus
        : `Job ${job.id} status updated to ${job.status}`;
      pushEntry(job.updated_at ?? null, statusLabel);
      const completionLabel = (() => {
        if (job.status === "failed") {
          return `Job ${job.id} 실패`;
        }
        if (job.status === "cancelled") {
          return `Job ${job.id} 취소됨`;
        }
        if (job.sequential && job.sequential.totalSegments) {
          return `Job ${job.id} 완료`;
        }
        return `Job ${job.id} completed`;
      })();
      pushEntry(job.finished_at ?? null, completionLabel);
      job.batches?.forEach((batch) => {
        pushEntry(
          batch.started_at ?? null,
          `Job ${job.id} · batch ${batch.batch_index + 1} started`,
        );
        pushEntry(
          batch.finished_at ?? null,
          `Job ${job.id} · batch ${batch.batch_index + 1} finished`,
        );
      });
    });

    return entries
      .sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      )
      .slice(0, 50);
  }, [projectSummary, content, projectJobs, localize]);

  const handleCareerSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCareerSavedAt(new Date().toISOString());
  };

  const handleSettingsToggle = (
    key: "emailUpdates" | "pushNotifications" | "tokenAlerts",
  ) => {
    setSettingsState((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleSettingsSelect = <K extends "locale" | "theme">(
    key: K,
    value: (typeof settingsState)[K],
  ) => {
    setSettingsState((prev) => ({ ...prev, [key]: value }));
    if (key === "locale") {
      setLocale(value as typeof settingsState.locale);
    }
  };

  const handleSettingsSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSettingsSavedAt(new Date().toISOString());
  };

  useEffect(() => {
    setSettingsState((prev) =>
      prev.locale === locale ? prev : { ...prev, locale },
    );
  }, [locale]);

  useEffect(() => {
    if (
      previousProjectRef.current &&
      previousProjectRef.current !== activeProjectId
    ) {
      clearExtraTab();
      setTab("preview");
    }
    previousProjectRef.current = activeProjectId ?? null;
  }, [activeProjectId, clearExtraTab, setTab]);

  if (!content) {
    return (
      <div className="flex h-full flex-col bg-white text-slate-800">
        <div className="flex items-center justify-end border-b border-slate-200 px-2 py-2">
          <UserProfileMenu
            avatarInitial={avatarInitial}
            avatarTone={avatarTone}
            avatarPreview={null}
            userName={user?.name ?? null}
            userEmail={user?.email ?? null}
            onOpenTab={(tabKey, label) => openExtraTab({ key: tabKey, label })}
            onLogout={logout}
            advancedProofreadEnabled={advancedProofreadEnabled}
            onToggleAdvancedProofread={handleAdvancedProofreadToggle}
          />
        </div>
        <div className="flex flex-1 flex-col gap-4 px-4 py-6">
          <div>
            <h3 className="text-xl font-semibold text-slate-900">
              {translate("rightpanel_empty_title", locale)}
            </h3>
            <p className="mt-1 text-sm text-slate-600">
              {translate("rightpanel_empty_subtitle", locale)}
            </p>
          </div>
          <ol className="space-y-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-700">
            <li>{translate("rightpanel_empty_step_upload", locale)}</li>
            <li>{translate("rightpanel_empty_step_chat", locale)}</li>
            <li>{translate("rightpanel_empty_step_tour", locale)}</li>
          </ol>
        </div>
      </div>
    );
  }

  return (
    <ProofreadIssuesProvider
      token={token ?? undefined}
      content={content ?? null}
      translationText={translationText}
      refreshContent={handleRefreshContent}
      projectId={content?.projectId ?? activeProjectId ?? null}
    >
      <div className="flex h-full flex-col">
        <div className="relative flex items-center justify-between border-b border-slate-200 px-2">
          <div className="flex flex-1 items-stretch">
            {resolvedTabs.map((tab) => {
              const isActive = activeTab === tab.key;
              const isAdvancedTab = tab.key === "proofread:findings";
              return (
                <button
                  key={tab.key}
                  className={`flex-1 px-4 py-2 text-sm font-medium ${
                    isActive
                      ? "border-b-2 border-indigo-500 text-indigo-600"
                      : "text-slate-500"
                  }`}
                  onClick={() => setTab(tab.key)}
                >
                  <span className="flex items-center justify-center gap-2">
                    {tab.label}
                    {isAdvancedTab ? (
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label="Close advanced proofread"
                        className="inline-flex h-4 w-4 items-center justify-center rounded text-xs text-slate-400 transition hover:bg-slate-200 hover:text-slate-600 focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500"
                        onClick={(event) => {
                          event.stopPropagation();
                          event.preventDefault();
                          setAdvancedProofreadEnabled(false);
                          setTab("proofread:editing");
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.stopPropagation();
                            event.preventDefault();
                            setAdvancedProofreadEnabled(false);
                            setTab("proofread:editing");
                          }
                        }}
                      >
                        <X className="h-3 w-3" aria-hidden="true" />
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
            {extraTab && (
              <button
                key={extraTab.key}
                className={`ml-2 px-4 py-2 text-sm font-medium ${
                  activeTab === extraTab.key
                    ? "border-b-2 border-indigo-500 text-indigo-600"
                    : "text-slate-500"
                }`}
                onClick={() => setTab(extraTab.key)}
              >
                {resolvedExtraTabLabel ?? extraTab.label}
              </button>
            )}
          </div>
          <UserProfileMenu
            avatarInitial={avatarInitial}
            avatarTone={avatarTone}
            avatarPreview={null}
            userName={user?.name ?? null}
            userEmail={user?.email ?? null}
            onOpenTab={(tabKey, label) => openExtraTab({ key: tabKey, label })}
            onLogout={logout}
            advancedProofreadEnabled={advancedProofreadEnabled}
            onToggleAdvancedProofread={handleAdvancedProofreadToggle}
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {activeTab === "preview" && (
            <div className="flex h-full flex-col gap-4 p-4">
              <Collapsible
                title={localize("rightpanel_preview_profile_title", "Profile")}
                titleAdornment={profileStatusIcon}
                isOpen={profileOpen}
                onToggle={() => setProfileOpen((prev) => !prev)}
                showDivider={false}
                keepMounted
                action={profileActionNode}
              >
                <ProjectProfileCard
                  content={content}
                  projectSummary={projectSummary}
                  onUpdated={onProfileUpdated}
                  onActionReady={setProfileControls}
                  onStatusChange={handleProfileStatusChange}
                />
              </Collapsible>
              <div className="space-y-4">
                <DocumentSummarySection
                  origin={originProfile}
                  translation={translationProfile}
                  localize={localize}
                  isLoading={Boolean(isContentLoading)}
                  originStatus={originSummaryStatus}
                  translationStatus={translationSummaryStatus}
                  translationFallback={translationFallback}
                  originFallback={originFallback}
                  onEditTranslationNotes={
                    token && activeProjectId && originProfile
                      ? handleOpenNotesModal
                      : undefined
                  }
                  translationNotesEditable={Boolean(
                    token && activeProjectId && originProfile,
                  )}
                  translationNotesSaving={isSavingTranslationNotes}
                  translationNotesError={translationNotesError}
                  onReanalyze={
                    canManuallyRefreshOrigin ? handleReanalyzeOrigin : undefined
                  }
                  isReanalyzing={isReanalyzingOrigin}
                  canReanalyze={canTriggerReanalysis}
                  reanalysisError={reanalyzeError}
                  originHeaderAccessory={originSummaryAccessory}
                  translationHeaderAccessory={translationSummaryAccessory}
                  originFileName={originFilename ?? null}
                />
              </div>
            </div>
          )}
          {activeTab === "proofread:findings" && (
            <ProofList agentState={proofreadingAgentState} />
          )}
          {activeTab === "proofread:editing" && (
            <ProofreadEditorProvider
              token={token ?? null}
              projectId={content?.projectId ?? activeProjectId ?? null}
              jobId={
                content?.proofreading?.jobId ??
                content?.content?.translation?.jobId ??
                content?.latestJob?.jobId ??
                null
              }
              translationFileId={null}
            >
              <ProofreadEditorTab
                originProfile={originProfile}
                originFallback={originFallback}
              />
            </ProofreadEditorProvider>
          )}
          {activeTab === "export" && (
            <ExportPanel
              content={content}
              projectSummary={projectSummary}
              onProfileUpdated={onProfileUpdated}
            />
          )}
          {activeTab === "profile" && (
            <div className="space-y-4 p-4 text-sm text-slate-700">
              <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
                <h3 className="text-base font-semibold text-slate-800">
                  {localize(
                    "rightpanel_profile_account_heading",
                    "Account overview",
                  )}
                </h3>
                <dl className="mt-3 space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <dt className="text-slate-500">
                      {localize("rightpanel_profile_field_name", "Name")}
                    </dt>
                    <dd className="font-medium text-slate-800">
                      {user?.name ?? "—"}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-slate-500">
                      {localize("rightpanel_profile_field_email", "Email")}
                    </dt>
                    <dd className="font-medium text-slate-800">
                      {user?.email ?? "—"}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-slate-500">
                      {localize("rightpanel_profile_field_plan", "Plan")}
                    </dt>
                    <dd className="font-medium text-slate-800">
                      {localize(
                        "rightpanel_profile_field_plan_value",
                        "Studio (beta)",
                      )}
                    </dd>
                  </div>
                  {projectSummary?.created_at && (
                    <div className="flex items-center justify-between">
                      <dt className="text-slate-500">
                        {localize(
                          "rightpanel_profile_field_project_since",
                          "Project since",
                        )}
                      </dt>
                      <dd className="font-medium text-slate-800">
                        {new Date(projectSummary.created_at).toLocaleString()}
                      </dd>
                    </div>
                  )}
                </dl>
              </section>
              <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
                <form onSubmit={handleCareerSubmit} className="space-y-3">
                  <header className="flex items-center justify-between">
                    <div>
                      <h3 className="text-base font-semibold text-slate-800">
                        {localize(
                          "rightpanel_profile_career_heading",
                          "Career update",
                        )}
                      </h3>
                      <p className="text-xs text-slate-500">
                        {localize(
                          "rightpanel_profile_career_description",
                          "Share recent publications or achievements to help reviewers understand context.",
                        )}
                      </p>
                    </div>
                    <button
                      type="submit"
                      className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700"
                    >
                      {localize(
                        "rightpanel_profile_career_save",
                        "Save note",
                      )}
                    </button>
                  </header>
                  <textarea
                    value={careerSummary}
                    onChange={(event) => setCareerSummary(event.target.value)}
                    className="h-32 w-full rounded border border-slate-300 px-2.5 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
                    placeholder={localize(
                      "rightpanel_profile_career_placeholder",
                      "Example: 2024 Sejong Literary Award finalist; specializing in speculative fiction translation.",
                    )}
                  />
                  {careerSavedAt && (
                    <p className="text-xs text-emerald-600">
                      {localize(
                        "rightpanel_profile_career_saved",
                        "Saved locally {{time}}.",
                        { time: new Date(careerSavedAt).toLocaleTimeString() },
                      )}
                    </p>
                  )}
                </form>
              </section>
            </div>
          )}
          {activeTab === "settings" && (
            <div className="space-y-4 p-4 text-sm text-slate-700">
              <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
                <form onSubmit={handleSettingsSubmit} className="space-y-4">
                  <header className="flex items-center justify-between">
                    <div>
                      <h3 className="text-base font-semibold text-slate-800">
                        {localize(
                          "rightpanel_settings_heading",
                          "Workspace settings",
                        )}
                      </h3>
                      <p className="text-xs text-slate-500">
                        {localize(
                          "rightpanel_settings_description",
                          "Adjust notification preferences and defaults for this session.",
                        )}
                      </p>
                    </div>
                    <button
                      type="submit"
                      className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700"
                    >
                      {localize(
                        "rightpanel_settings_save",
                        "Save settings",
                      )}
                    </button>
                  </header>
                  <div className="space-y-3">
                    <label className="flex items-center justify-between gap-3">
                      <span className="text-sm text-slate-700">
                        {localize(
                          "rightpanel_settings_email_updates",
                          "Email updates",
                        )}
                      </span>
                      <input
                        type="checkbox"
                        checked={settingsState.emailUpdates}
                        onChange={() => handleSettingsToggle("emailUpdates")}
                        className="h-4 w-4"
                      />
                    </label>
                    <label className="flex items-center justify-between gap-3">
                      <span className="text-sm text-slate-700">
                        {localize(
                          "rightpanel_settings_push_notifications",
                          "Push notifications",
                        )}
                      </span>
                      <input
                        type="checkbox"
                        checked={settingsState.pushNotifications}
                        onChange={() =>
                          handleSettingsToggle("pushNotifications")
                        }
                        className="h-4 w-4"
                      />
                    </label>
                    <label className="flex items-center justify-between gap-3">
                      <span className="text-sm text-slate-700">
                        {localize(
                          "rightpanel_settings_token_alerts",
                          "Token usage alerts",
                        )}
                      </span>
                      <input
                        type="checkbox"
                        checked={settingsState.tokenAlerts}
                        onChange={() => handleSettingsToggle("tokenAlerts")}
                        className="h-4 w-4"
                      />
                    </label>
                    <div className="flex flex-col gap-1">
                      <label className="text-sm text-slate-700">
                        {localize(
                          "rightpanel_settings_language",
                          "Preferred language",
                        )}
                      </label>
                      <select
                        value={settingsState.locale}
                        onChange={(event) =>
                          handleSettingsSelect(
                            "locale",
                            event.target.value as "ko" | "en",
                          )
                        }
                        className="rounded border border-slate-300 px-2.5 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
                      >
                        <option value="ko">한국어</option>
                        <option value="en">English</option>
                      </select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-sm text-slate-700">
                        {localize("rightpanel_settings_theme", "Theme")}
                      </label>
                      <select
                        value={settingsState.theme}
                        onChange={(event) =>
                          handleSettingsSelect(
                            "theme",
                            event.target.value as "system" | "light" | "dark",
                          )
                        }
                        className="rounded border border-slate-300 px-2.5 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
                      >
                        <option value="system">
                          {localize(
                            "rightpanel_settings_theme_system",
                            "Follow system",
                          )}
                        </option>
                        <option value="light">
                          {localize(
                            "rightpanel_settings_theme_light",
                            "Light",
                          )}
                        </option>
                        <option value="dark">
                          {localize(
                            "rightpanel_settings_theme_dark",
                            "Dark",
                          )}
                        </option>
                      </select>
                    </div>
                  </div>
                  {settingsSavedAt && (
                    <p className="text-xs text-emerald-600">
                      {localize(
                        "rightpanel_settings_saved",
                        "Settings captured {{time}}.",
                        { time: new Date(settingsSavedAt).toLocaleTimeString() },
                      )}
                    </p>
                  )}
                </form>
              </section>
            </div>
          )}
          {activeTab === "activity" && (
            <div className="space-y-4 p-4 text-sm text-slate-700">
              <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
                <header className="flex items-center justify-between">
                  <div>
                    <h3 className="text-base font-semibold text-slate-800">
                      {localize(
                        "rightpanel_activity_heading",
                        "Recent activity",
                      )}
                    </h3>
                    <p className="text-xs text-slate-500">
                      {localize(
                        "rightpanel_activity_description",
                        "Merged from jobs, batches, proofreading, and quality records. Showing the latest 50 events.",
                      )}
                    </p>
                  </div>
                  {isJobsLoading && (
                    <span className="text-xs text-slate-400">
                      {localize(
                        "rightpanel_activity_loading",
                        "Loading…",
                      )}
                    </span>
                  )}
                </header>
                <div className="mt-3 space-y-2 text-xs text-slate-600">
                  {activityEntries.length === 0 && (
                    <p>
                      {localize(
                        "rightpanel_activity_empty",
                        "No activity captured yet for this project.",
                      )}
                    </p>
                  )}
                  {activityEntries.map((entry) => (
                    <p
                      key={`${entry.timestamp}-${entry.label}`}
                      className="flex justify-between gap-3"
                    >
                      <span>{new Date(entry.timestamp).toLocaleString()}</span>
                      <span className="text-right text-slate-500">
                        {entry.label}
                      </span>
                    </p>
                  ))}
                </div>
              </section>
            </div>
          )}
          {activeTab === "terms" && (
            <div className="space-y-4 p-4 text-sm text-slate-700">
              <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
                <h3 className="text-base font-semibold text-slate-800">
                  {localize("rightpanel_terms_heading", "Terms of use")}
                </h3>
                <p className="mt-2 text-sm text-slate-600">
                  {localize(
                    "rightpanel_terms_preview_hint",
                    "Preview of the upcoming legal document.",
                  )}
                </p>
                <p className="mt-2 text-sm text-slate-600">
                  {localize(
                    "rightpanel_terms_instruction_prefix",
                    "Place the finalized markdown file at",
                  )}{" "}
                  <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
                    docs/legal/terms.md
                  </code>{" "}
                  {localize(
                    "rightpanel_terms_instruction_suffix",
                    "and this panel will render it in a future update.",
                  )}
                </p>
                <p className="mt-2 text-xs text-slate-500">
                  {localize(
                    "rightpanel_terms_last_updated",
                    "Current placeholder last updated {{date}}.",
                    { date: new Date().toLocaleDateString() },
                  )}
                </p>
              </section>
            </div>
          )}
          {activeTab === "privacy" && (
            <div className="space-y-4 p-4 text-sm text-slate-700">
              <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
                <h3 className="text-base font-semibold text-slate-800">
                  {localize("rightpanel_privacy_heading", "Privacy notice")}
                </h3>
                <p className="mt-2 text-sm text-slate-600">
                  {localize(
                    "rightpanel_privacy_preview_prefix",
                    "The canonical policy will be read from",
                  )}{" "}
                  <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
                    docs/legal/privacy.md
                  </code>
                  .
                </p>
                <p className="mt-2 text-sm text-slate-600">
                  {localize(
                    "rightpanel_privacy_preview_suffix",
                    "Until then, use this placeholder to verify layout and links.",
                  )}
                </p>
                <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-slate-500">
                  <li>
                    {localize(
                      "rightpanel_privacy_bullet_collection",
                      "Collection: translation manuscripts, quality scores, proofreading decisions.",
                    )}
                  </li>
                  <li>
                    {localize(
                      "rightpanel_privacy_bullet_processing",
                      "Processing: OpenAI endpoints configured per project plan.",
                    )}
                  </li>
                  <li>
                    {localize(
                      "rightpanel_privacy_bullet_retention",
                      "Retention: project artifacts kept for 90 days unless extended by editors.",
                    )}
                  </li>
                </ul>
              </section>
            </div>
          )}
        </div>
      </div>
      <QualityAssessmentDialog
        open={qualityDialogOpen}
        onClose={closeQualityDialog}
        stage={content?.qualityAssessmentStage}
        latest={content?.qualityAssessment ?? null}
      />
      {isOriginModalOpen ? (
        <Modal
          title={localize(
            "rightpanel_origin_modal_title",
            "Original manuscript",
          )}
          onClose={handleCloseOriginModal}
          maxWidthClass="max-w-4xl"
          showCloseButton
          closeLabel={localize(
            "rightpanel_origin_modal_close",
            "Close manuscript viewer",
          )}
        >
          <div className="space-y-4 text-sm text-slate-700">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600">
              <span className="text-slate-700">
                <span className="font-semibold text-slate-700">
                  {originTitle?.trim() ? originTitle.trim() : "—"}
                </span>
                {originAuthor?.trim() ? (
                  <span className="text-slate-500">
                    {" "}
                    · {originAuthor.trim()}
                  </span>
                ) : null}
              </span>
              {originFilename ? (
                <span className="text-xs text-slate-400">{originFilename}</span>
              ) : null}
            </div>
            {originMetricLabels.length || originTimestampLabel ? (
              <p className="text-sm text-slate-600">
                {originMetricLabels.length
                  ? originMetricLabels.join(" · ")
                  : null}
                {originMetricLabels.length && originTimestampLabel
                  ? " · "
                  : null}
                {originTimestampLabel
                  ? localize(
                      "rightpanel_summary_metric_updated",
                      "Updated: {{timestamp}}",
                      { timestamp: originTimestampLabel },
                    )
                  : null}
              </p>
            ) : null}
            <div className="max-h-[60vh] overflow-y-auto rounded border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-700">
              {originContentAvailable ? (
                <pre className="whitespace-pre-wrap break-words text-slate-700">
                  {originText}
                </pre>
              ) : (
                <p className="text-slate-400">
                  {localize(
                    "rightpanel_origin_modal_empty",
                    "Manuscript text is not available yet.",
                  )}
                </p>
              )}
            </div>
          </div>
        </Modal>
      ) : null}
      {isNotesModalOpen ? (
        <Modal
          title={localize(
            "rightpanel_translation_notes_title",
            "Translation notes",
          )}
          onClose={handleCloseNotesModal}
          maxWidthClass="max-w-4xl"
        >
          <TranslationNotesEditor
            notes={originProfile?.translationNotes ?? null}
            localize={localize}
            onSave={handleSaveTranslationNotes}
            onCancel={handleCloseNotesModal}
            isSaving={isSavingTranslationNotes}
            error={translationNotesError}
          />
        </Modal>
      ) : null}
      {isTranslationModalOpen ? (
        <Modal
          title={localize(
            "rightpanel_translation_modal_title",
            "Translated manuscript",
          )}
          onClose={handleCloseTranslationModal}
          maxWidthClass="max-w-4xl"
          showCloseButton
          closeLabel={localize(
            "rightpanel_translation_modal_close",
            "Close translation viewer",
          )}
        >
          <div className="space-y-4 text-sm text-slate-700">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600">
              <span className="text-slate-700">
                <span className="font-semibold text-slate-700">
                  {translationTitle?.trim() ? translationTitle.trim() : "—"}
                </span>
                {translationAuthor?.trim() ? (
                  <span className="text-slate-500">
                    {" "}
                    · {translationAuthor.trim()}
                  </span>
                ) : null}
              </span>
            </div>
            {translationMetricLabels.length || translationTimestampLabel ? (
              <p className="text-sm text-slate-600">
                {translationMetricLabels.length
                  ? translationMetricLabels.join(" · ")
                  : null}
                {translationMetricLabels.length && translationTimestampLabel
                  ? " · "
                  : null}
                {translationTimestampLabel
                  ? localize(
                      "rightpanel_summary_metric_updated",
                      "Updated: {{timestamp}}",
                      { timestamp: translationTimestampLabel },
                    )
                  : null}
              </p>
            ) : null}
            <div className="max-h-[60vh] overflow-y-auto rounded border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-700">
              {translationModalText.trim().length ? (
                <pre className="whitespace-pre-wrap break-words text-slate-700">
                  {translationModalText}
                </pre>
              ) : (
                <p className="text-slate-400">
                  {localize(
                    "rightpanel_translation_modal_empty",
                    "Translated text is not available yet.",
                  )}
                </p>
              )}
            </div>
          </div>
        </Modal>
      ) : null}
    </ProofreadIssuesProvider>
  );
};
