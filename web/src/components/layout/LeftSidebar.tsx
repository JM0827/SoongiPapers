import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import {
  ChevronLeft,
  ChevronRight,
  UploadCloud,
  RefreshCcw,
  PenSquare,
  ShieldCheck,
  Search,
  BookOpen,
  Info,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { useProjectStore } from "../../store/project.store";
import { useProjectList } from "../../hooks/useProjectData";
import { SidebarProjectButton } from "./SidebarProjectButton";
import { useUIStore, DEFAULT_SIDEBAR_SECTIONS } from "../../store/ui.store";
import { useCreateProject } from "../../hooks/useCreateProject";
import { translate } from "../../lib/locale";
import { useUILocale } from "../../hooks/useUILocale";
import { useAuthStore } from "../../store/auth.store";
import { api } from "../../services/api";
import { projectKeys } from "../../hooks/useProjectData";
import { useUsage } from "../../hooks/useJobsBatches";
import type { ProjectSummary } from "../../types/domain";
import { Modal } from "../common/Modal";
import { NewProjectIcon } from "../icons/ProjectIcons";
import { useWorkflowStore } from "../../store/workflow.store";
import { useChatActionStore } from "../../store/chatAction.store";
import { SidebarQuickActions } from "./sidebar/SidebarQuickActions";
import type { QuickAction } from "./sidebar/SidebarQuickActions";
import { SidebarActivitySection } from "./sidebar/SidebarActivitySection";
import { useProjectContext } from "../../hooks/useProjectContext";
import {
  getOriginPrepGuardMessage,
  isOriginPrepReady,
} from "../../lib/originPrep";
import { useNavigate } from "react-router-dom";
import { copyrightConsentContent } from "../../content/userConsent";

const languageOptions = [
  { value: "Korean", labelKey: "language_korean", fallback: "Korean" },
  { value: "English", labelKey: "language_english", fallback: "English" },
  { value: "Japanese", labelKey: "language_japanese", fallback: "Japanese" },
  { value: "Chinese", labelKey: "language_chinese", fallback: "Chinese" },
  { value: "Spanish", labelKey: "language_spanish", fallback: "Spanish" },
  { value: "French", labelKey: "language_french", fallback: "French" },
  { value: "German", labelKey: "language_german", fallback: "German" },
];

const usageEventLabelMessages: Record<string, { key: string; fallback: string }> = {
  translate: { key: 'sidebar_usage_event_translate', fallback: 'Translation' },
  quality: { key: 'sidebar_usage_event_quality', fallback: 'Quality' },
  proofread: { key: 'sidebar_usage_event_proofread', fallback: 'Proofread' },
  ebook: { key: 'sidebar_usage_event_ebook', fallback: 'eBook' },
};

const formatNumber = (value: number) => value.toLocaleString();

const formatDateTime = (value?: string | null) => {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

const formatRecentTimestamp = (value?: string | null) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};

type ProjectModalProfile = {
  bookTitleOriginal: string;
  bookTitleEnglish: string;
  authorName: string;
  translatorName: string;
  authorNotes: string;
  translatorNotes: string;
  copyrightConsent: boolean;
  consentRecord: UserConsentRecord;
};

interface UserConsentRecord {
  consented?: boolean;
  status?: string;
  statusKo?: string;
  statusEn?: string;
  consentedAt?: string | null;
  userName?: string | null;
  originTitle?: string | null;
  translatedTitle?: string | null;
  authorName?: string | null;
  translatorName?: string | null;
  version?: number;
  [key: string]: unknown;
}

const coerceMetaString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const parseProjectMeta = (meta: ProjectSummary["meta"]): Record<string, unknown> => {
  if (!meta) return {};
  if (typeof meta === "string") {
    try {
      const parsed = JSON.parse(meta);
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch (error) {
      console.warn("[sidebar] failed to parse project meta", error);
      return {};
    }
  }
  return { ...meta };
};

const parseUserConsent = (
  value: ProjectSummary["user_consent"],
): UserConsentRecord => {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch (error) {
      console.warn("[sidebar] failed to parse project user_consent", error);
      return {};
    }
  }
  if (typeof value === "object") {
    return { ...value };
  }
  return {};
};

const pickFirstText = (
  ...values: Array<string | null | undefined | unknown>
): string => {
  for (const value of values) {
    const text = coerceMetaString(value);
    if (text.length) return text;
  }
  return "";
};

const deriveProjectModalProfile = (project: ProjectSummary): ProjectModalProfile => {
  const meta = parseProjectMeta(project.meta);
  const userConsent = parseUserConsent(project.user_consent);
  return {
    bookTitleOriginal: pickFirstText(project.book_title, project.title),
    bookTitleEnglish: pickFirstText(meta.bookTitleEn, meta.book_title_en),
    authorName: pickFirstText(project.author_name, meta.author),
    translatorName: pickFirstText(project.translator_name, meta.translator),
    authorNotes: pickFirstText(
      meta.originalAuthorNotes,
      meta.context,
      project.description,
      project.intention,
    ),
    translatorNotes: pickFirstText(meta.translatorNotes, meta.notes),
    copyrightConsent: (() => {
      if (
        userConsent?.consented === true ||
        userConsent?.copyrightConsent === true ||
        userConsent?.copyright_consent === true
      ) {
        return true;
      }
      const statusRaw = (userConsent?.status ?? "")
        .toString()
        .trim()
        .toLowerCase();
      const statusEnRaw = (userConsent?.statusEn ?? userConsent?.statusKo ?? "")
        .toString()
        .trim()
        .toLowerCase();
      const normalized = statusRaw.replace(/\s+/g, "");
      const normalizedEn = statusEnRaw.replace(/\s+/g, "");
      const positiveTokens = new Set([
        "동의",
        "동의함",
        "consented",
        "consent",
        "received",
        "granted",
        "yes",
      ]);
      if (positiveTokens.has(normalized) || positiveTokens.has(normalizedEn)) {
        return true;
      }
      return false;
    })(),
    consentRecord: userConsent,
  };
};

const sanitizeModalProfile = (profile: ProjectModalProfile): ProjectModalProfile => ({
  bookTitleOriginal: profile.bookTitleOriginal.trim(),
  bookTitleEnglish: profile.bookTitleEnglish.trim(),
  authorName: profile.authorName.trim(),
  translatorName: profile.translatorName.trim(),
  authorNotes: profile.authorNotes.trim(),
  translatorNotes: profile.translatorNotes.trim(),
  copyrightConsent: Boolean(profile.copyrightConsent),
  consentRecord: profile.consentRecord ?? {},
});

const buildUpdatedProjectMeta = (
  baseMeta: Record<string, unknown>,
  profile: ProjectModalProfile,
) => {
  const next = { ...baseMeta };
  next.author = profile.authorName || null;
  next.translator = profile.translatorName || null;
  next.bookTitleEn = profile.bookTitleEnglish || null;
  next.book_title_en = profile.bookTitleEnglish || null;
  next.originalAuthorNotes = profile.authorNotes || null;
  next.translatorNotes = profile.translatorNotes || null;
  next.context = profile.authorNotes || null;
  next.notes = profile.translatorNotes || null;
  return next;
};

const buildUserConsentRecord = (params: {
  consented: boolean;
  profile: ProjectModalProfile;
  userName: string | null;
  previous: UserConsentRecord;
}): UserConsentRecord => {
  const { consented, profile, userName, previous } = params;

  const historical = {
    ...(previous ?? {}),
    ...(profile.consentRecord ?? {}),
  } as UserConsentRecord;

  const version =
    typeof historical.version === "number" && Number.isFinite(historical.version)
      ? historical.version
      : 1;

  const base: UserConsentRecord = {
    version,
    userName:
      userName ??
      (typeof historical.userName === "string" ? historical.userName : null),
    originTitle:
      profile.bookTitleOriginal ||
      (typeof historical.originTitle === "string" ? historical.originTitle : null),
    translatedTitle:
      profile.bookTitleEnglish ||
      (typeof historical.translatedTitle === "string"
        ? historical.translatedTitle
        : null),
    authorName:
      profile.authorName ||
      (typeof historical.authorName === "string" ? historical.authorName : null),
    translatorName:
      profile.translatorName ||
      (typeof historical.translatorName === "string"
        ? historical.translatorName
        : null),
  };

  if (consented) {
    const existingConsentTimestamp =
      (historical.consented === true && typeof historical.consentedAt === "string"
        ? historical.consentedAt
        : null) ?? null;
    return {
      ...base,
      consented: true,
      status: "동의",
      statusKo: "동의",
      statusEn: "received",
      consentedAt: existingConsentTimestamp ?? new Date().toISOString(),
    };
  }

  return {
    ...base,
    consented: false,
    status: "동의 안함",
    statusKo: "동의 안함",
    statusEn: "not_received",
    consentedAt: null,
  };
};

export const LeftSidebar = () => {
  const navigate = useNavigate();
  const { data: projects } = useProjectList();
  const activeProjectId = useProjectStore((state) => state.activeProjectId);
  const setActiveProject = useProjectStore((state) => state.setActiveProject);
  const setActiveProjectName = useProjectStore(
    (state) => state.setActiveProjectName,
  );
  const purgeProject = useProjectStore((state) => state.purgeProject);
  const isCollapsed = useUIStore((state) => state.isSidebarCollapsed);
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);
  const { createProject, isCreating } = useCreateProject();
  const token = useAuthStore((state) => state.token);
  const currentUser = useAuthStore((state) => state.user);
  const queryClient = useQueryClient();
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

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [newProjectTitle, setNewProjectTitle] = useState("");
  const [originLang, setOriginLang] = useState("Korean");
  const [targetLang, setTargetLang] = useState("English");

  const [modalState, setModalState] = useState<
    | {
        type: "rename";
        project: ProjectSummary;
        value: string;
        submitting: boolean;
        profile: ProjectModalProfile;
        initialProfile: ProjectModalProfile;
      }
    | { type: "delete"; project: ProjectSummary; submitting: boolean }
    | null
  >(null);
  const [toast, setToast] = useState<{ id: number; message: string } | null>(
    null,
  );
  const [showConsentInfo, setShowConsentInfo] = useState(false);

  const newProjectLabel = localize('sidebar_new_project', 'New project');
  const newProjectTooltip = localize(
    'sidebar_new_project_tooltip',
    'Create a new translation project.',
  );
  const openSidebarTitle = localize('sidebar_toggle_open', 'Open sidebar');
  const closeSidebarTitle = localize('sidebar_toggle_close', 'Close sidebar');
  const loadingLabel = localize('common_loading', 'Loading…');
  const emptySearchMessage = localize(
    'sidebar_empty_search',
    'No projects match your current filters.',
  );
  const showMoreLabel = localize('sidebar_section_show_more', 'Show more');
  const showLessLabel = localize('sidebar_section_show_less', 'Show less');
  const activeSectionTitle = localize(
    'sidebar_section_active',
    'Active projects',
  );
  const completedSectionTitle = localize(
    'sidebar_section_completed',
    'Completed projects',
  );
  const consentLabel = localize(
    'project_consent_label',
    'Original copyright consent',
  );
  const consentStatusEnabled = localize(
    'project_consent_received',
    'Received',
  );
  const consentStatusDisabled = localize(
    'project_consent_not_received',
    'Not received',
  );
  const consentInfoShow = localize(
    'project_consent_info_show',
    'Show consent guidance',
  );
  const consentInfoHide = localize(
    'project_consent_info_hide',
    'Hide consent guidance',
  );
  const consentContent =
    copyrightConsentContent[locale] ?? copyrightConsentContent.ko;
  const consentInfoToggleLabel = showConsentInfo ? consentInfoHide : consentInfoShow;
  const consentEnabled =
    modalState?.type === "rename" && modalState.profile.copyrightConsent;
  const consentStatusLabel = consentEnabled
    ? consentStatusEnabled
    : consentStatusDisabled;

  const translationAgentState = useWorkflowStore((state) => state.translation);
  const proofreadingAgentState = useWorkflowStore((state) => state.proofreading);
  const qualityAgentState = useWorkflowStore((state) => state.quality);
  const resetTranslation = useWorkflowStore((state) => state.resetTranslation);
  const resetProofreading = useWorkflowStore((state) => state.resetProofreading);
  const resetQuality = useWorkflowStore((state) => state.resetQuality);
  const chatActionExecute = useChatActionStore((state) => state.execute);
  const chatExecutorReady = useChatActionStore((state) => Boolean(state.executor));
  const { snapshot } = useProjectContext();
  const { data: modalUsageData, isLoading: isUsageLoading } = useUsage(
    modalState?.type === "rename" ? modalState.project.project_id : null,
  );

  const sidebarSections = useUIStore((state) => state.sidebarSections);
  const setSidebarSection = useUIStore((state) => state.setSidebarSection);


  const orderedProjects = useMemo(
    () =>
      (projects ?? []).filter(
        (project) => project.status?.toLowerCase() !== "archived",
      ),
    [projects],
  );

  const invalidateProjects = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: projectKeys.list });
  }, [queryClient]);

  const invalidateProjectContent = useCallback(
    async (projectId: string) => {
      await queryClient.invalidateQueries({
        queryKey: projectKeys.content(projectId),
      });
    },
    [queryClient],
  );

  const showToast = useCallback((message: string) => {
    setToast({ id: Date.now(), message });
  }, []);

  const openRenameModal = useCallback((project: ProjectSummary) => {
    const derivedProfile = sanitizeModalProfile(
      deriveProjectModalProfile(project),
    );
    setShowConsentInfo(false);
    setModalState({
      type: "rename",
      project,
      value: project.title ?? "",
      submitting: false,
      profile: { ...derivedProfile },
      initialProfile: { ...derivedProfile },
    });
  }, []);

  const openDeleteModal = useCallback((project: ProjectSummary) => {
    setModalState({ type: "delete", project, submitting: false });
  }, []);

  const closeModal = useCallback(() => {
    setShowConsentInfo(false);
    setModalState(null);
  }, []);

  const setProfileField = useCallback(
    <K extends keyof ProjectModalProfile>(
      field: K,
      value: ProjectModalProfile[K],
    ) => {
      setModalState((prev) =>
        prev && prev.type === "rename"
          ? {
              ...prev,
              profile: { ...prev.profile, [field]: value },
            }
          : prev,
      );
    },
    [],
  );

  const submitRename = useCallback(async () => {
    if (!modalState || modalState.type !== "rename") return;
    if (!token) {
      window.alert(
        localize(
          "sidebar_error_auth_required",
          "Please sign in again to continue.",
        ),
      );
      return;
    }

    const trimmed = modalState.value.trim();
    const sanitizedProfile = sanitizeModalProfile(modalState.profile);
    const originalProfile = sanitizeModalProfile(modalState.initialProfile);
    const previousUserConsent = parseUserConsent(modalState.project.user_consent);
    const nameChanged = trimmed !== (modalState.project.title ?? "");
    const profileChanged =
      JSON.stringify(sanitizedProfile) !== JSON.stringify(originalProfile);

    if (!trimmed) {
      window.alert(
        localize(
          "sidebar_error_project_name_required",
          "Project name cannot be empty.",
        ),
      );
      return;
    }
    if (!nameChanged && !profileChanged) {
      closeModal();
      return;
    }

    const currentUserName = (() => {
      const userName = currentUser?.name ?? "";
      const trimmedName = userName.trim();
      if (trimmedName.length > 0) return trimmedName;
      if (sanitizedProfile.translatorName.length > 0)
        return sanitizedProfile.translatorName;
      return null;
    })();

    const nextUserConsent = buildUserConsentRecord({
      consented: sanitizedProfile.copyrightConsent,
      profile: sanitizedProfile,
      userName: currentUserName,
      previous: previousUserConsent,
    });

    setModalState({
      ...modalState,
      submitting: true,
      profile: { ...sanitizedProfile, consentRecord: nextUserConsent },
    });
    try {
      const baseMeta = parseProjectMeta(modalState.project.meta);
      const updatedMeta = buildUpdatedProjectMeta(baseMeta, sanitizedProfile);
      await api.updateProject(token, modalState.project.project_id, {
        title: trimmed,
        book_title: sanitizedProfile.bookTitleOriginal || undefined,
        author_name: sanitizedProfile.authorName || undefined,
        translator_name: sanitizedProfile.translatorName || undefined,
        description: sanitizedProfile.authorNotes || undefined,
        intention: undefined,
        memo: sanitizedProfile.translatorNotes || undefined,
        meta: updatedMeta,
        user_consent: nextUserConsent,
      });
      if (modalState.project.project_id === activeProjectId && nameChanged) {
        setActiveProjectName(trimmed);
      }
      await invalidateProjects();
      await invalidateProjectContent(modalState.project.project_id);
      showToast(
        localize(
          "sidebar_toast_project_updated",
          "Project details updated.",
        ),
      );
      closeModal();
    } catch (error) {
      console.error("[sidebar] failed to rename project", error);
      window.alert(
        localize(
          "sidebar_error_rename_failed",
          "Failed to rename the project. Please try again.",
        ),
      );
      setModalState((prev) =>
        prev && prev.type === "rename"
          ? { ...prev, submitting: false, profile: sanitizedProfile }
          : prev,
      );
    }
  }, [
    modalState,
    token,
    activeProjectId,
    setActiveProjectName,
    invalidateProjects,
    invalidateProjectContent,
    closeModal,
    showToast,
    localize,
    currentUser,
  ]);

  const submitDelete = useCallback(async () => {
    if (!modalState || modalState.type !== "delete") return;
    if (!token) {
      window.alert(
        localize(
          "sidebar_error_auth_required",
          "Please sign in again to continue.",
        ),
      );
      return;
    }

    setModalState({ ...modalState, submitting: true });
    try {
      await api.updateProject(token, modalState.project.project_id, {
        status: "archived",
      });
      purgeProject(modalState.project.project_id);
      await invalidateProjects();
      await invalidateProjectContent(modalState.project.project_id);
      showToast(
        localize(
          "sidebar_toast_project_deleted",
          "Project archived. You can restore it within 7 days.",
        ),
      );
      closeModal();
    } catch (error) {
      console.error("[sidebar] failed to delete project", error);
      window.alert(
        localize(
          "sidebar_error_delete_failed",
          "Failed to delete the project. Please try again.",
        ),
      );
      setModalState((prev) =>
        prev && prev.type === "delete" ? { ...prev, submitting: false } : prev,
      );
    }
  }, [
    modalState,
    token,
    purgeProject,
    invalidateProjects,
    invalidateProjectContent,
    closeModal,
    showToast,
  ]);

  const renderCreateDialog = () => (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/60 px-4">
      <form
        onSubmit={handleCreateProject}
        className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-xl"
      >
        <h2 className="text-lg font-semibold text-slate-900">
          {localize('sidebar_create_title', 'New project')}
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          {localize(
            'sidebar_create_description',
            'Name your project and choose languages to get started.',
          )}
        </p>

        <label className="mt-4 block text-xs font-semibold tracking-wide text-slate-500">
          {localize('sidebar_create_field_title', 'Title')}
          <input
            value={newProjectTitle}
            onChange={(event) => setNewProjectTitle(event.target.value)}
            placeholder={localize('sidebar_create_placeholder_title', 'New project')}
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-400 focus:outline-none"
          />
        </label>

        <div className="mt-4 grid grid-cols-2 gap-4">
          <label className="text-xs font-semibold tracking-wide text-slate-500">
            {localize('sidebar_create_field_origin', 'Origin language')}
            <select
              value={originLang}
              onChange={(event) => setOriginLang(event.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-indigo-400 focus:outline-none"
            >
              {languageOptions.map((language) => (
                <option key={language.value} value={language.value}>
                  {localize(language.labelKey, language.fallback)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-semibold tracking-wide text-slate-500">
            {localize('sidebar_create_field_target', 'Target language')}
            <select
              value={targetLang}
              onChange={(event) => setTargetLang(event.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-indigo-400 focus:outline-none"
            >
              {languageOptions.map((language) => (
                <option key={language.value} value={language.value}>
                  {localize(language.labelKey, language.fallback)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <footer className="mt-6 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={handleDialogClose}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-100"
          >
            {localize('common_cancel', 'Cancel')}
          </button>
          <button
            type="submit"
            disabled={isCreating}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-indigo-300"
          >
            {isCreating
              ? localize('sidebar_create_submitting', 'Creating…')
              : localize('sidebar_create_submit', 'Create')}
          </button>
        </footer>
      </form>
    </div>
  );

  const handleCompleteProject = useCallback(
    async (project: ProjectSummary) => {
      if (!token) {
        window.alert(
          localize(
            "sidebar_error_auth_required",
            "Please sign in again to continue.",
          ),
        );
        return;
      }

      try {
        await api.updateProject(token, project.project_id, {
          status: "completed",
        });
        await invalidateProjects();
        await invalidateProjectContent(project.project_id);
      } catch (error) {
        console.error("[sidebar] failed to mark project complete", error);
        window.alert(
          localize(
            "sidebar_error_complete_failed",
            "Failed to mark the project as completed. Please try again.",
          ),
        );
      }
    },
    [token, invalidateProjects, invalidateProjectContent],
  );

  const projectMap = useMemo(() => {
    const map = new Map<string, ProjectSummary>();
    orderedProjects.forEach((project) => {
      map.set(project.project_id, project);
    });
    return map;
  }, [orderedProjects]);

  const projectScopeKey = activeProjectId ?? "global";
  const sectionState = {
    ...DEFAULT_SIDEBAR_SECTIONS,
    ...(sidebarSections[projectScopeKey] ?? {}),
  };
  const quickActionsOpen = sectionState.quickActions;
  const activitySectionOpen = sectionState.activity;

  const handleDialogClose = useCallback(() => {
    if (isCreating) return;
    setIsDialogOpen(false);
    setNewProjectTitle("");
    setOriginLang("Korean");
    setTargetLang("English");
  }, [isCreating]);

  const handleCreateProject = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      try {
        await createProject({
          title: newProjectTitle.trim() || undefined,
          originLang,
          targetLang,
        });
        handleDialogClose();
      } catch (error) {
        console.error("[sidebar] failed to create project", error);
        window.alert(
          localize(
            "sidebar_error_create_failed",
            "Failed to create the project. Please try again.",
          ),
        );
      }
    },
    [createProject, newProjectTitle, originLang, targetLang, handleDialogClose],
  );

  const { activeProjectsLimited, completedProjectsLimited } = useMemo(() => {
    const actives: ProjectSummary[] = [];
    const completes: ProjectSummary[] = [];

    for (const project of orderedProjects) {
      const status = (project.status ?? "").toLowerCase();
      if (status === "completed" || status === "complete") {
        completes.push(project);
        continue;
      }
      actives.push(project);
    }

    return {
      activeProjectsLimited: actives,
      completedProjectsLimited: completes,
    };
  }, [orderedProjects]);

  const [showAllActive, setShowAllActive] = useState(false);
  const [showAllCompleted, setShowAllCompleted] = useState(false);

  const activeProjectsPrepared = useMemo(
    () => [...activeProjectsLimited],
    [activeProjectsLimited],
  );

  useEffect(() => {
    if (!activeProjectId && orderedProjects.length > 0) {
      const candidate = orderedProjects[0];
      setActiveProject(candidate.project_id);
      setActiveProjectName(candidate.title ?? null);
    }
  }, [
    activeProjectId,
    orderedProjects,
    setActiveProject,
    setActiveProjectName,
  ]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const stageLabelMap: Record<string, { key: string; fallback: string }> = {
    origin: { key: 'sidebar_activity_origin', fallback: 'Origin' },
    translation: { key: 'sidebar_activity_translation', fallback: 'Translation' },
    proofreading: { key: 'sidebar_activity_proofreading', fallback: 'Proofreading' },
    quality: { key: 'sidebar_activity_quality', fallback: 'Quality review' },
    publishing: { key: 'sidebar_activity_publishing', fallback: 'Publishing' },
  };

  const recentUpdates = useMemo(() => {
    const lines: Array<{ id: string; text: string }> = [];
    const pushUpdate = (id: string, timestamp?: string | null) => {
      const formatted = formatRecentTimestamp(timestamp);
      if (!formatted) return;
      const labelMeta = stageLabelMap[id];
      const label = labelMeta
        ? localize(labelMeta.key, labelMeta.fallback)
        : id;
      lines.push({
        id,
        text: localize(
          'sidebar_activity_update',
          '{{label}} last updated {{timestamp}}',
          { label, timestamp: formatted },
        ),
      });
    };

    pushUpdate('origin', snapshot.origin.lastUpdatedAt);
    pushUpdate(
      'translation',
      snapshot.translation.lastUpdatedAt ??
        snapshot.lifecycle.translation?.lastUpdatedAt ??
        null,
    );
    pushUpdate('proofreading', snapshot.lifecycle.proofreading?.lastUpdatedAt ?? null);
    pushUpdate('quality', snapshot.lifecycle.quality?.lastUpdatedAt ?? null);
    pushUpdate('publishing', snapshot.lifecycle.publishing?.lastUpdatedAt ?? null);

    return lines;
  }, [localize, snapshot]);

  const originPrepSnapshot = snapshot.originPrep ?? null;
  const hasOriginContent = snapshot.origin.hasContent;
  const originPrepReady = originPrepSnapshot
    ? isOriginPrepReady(originPrepSnapshot)
    : false;
  const originAnalysisRunning =
    originPrepSnapshot?.analysis.status === "running";
  const originReady = hasOriginContent && originPrepReady;
  const translationPrepReady = hasOriginContent && originPrepReady;
  const translationRunning =
    translationAgentState.status === "running" ||
    translationAgentState.status === "queued";
  const translationDone =
    translationAgentState.status === "done" || snapshot.translation.hasContent;
  const translationFailed = translationAgentState.status === "failed";
  const hasTranslation = snapshot.translation.hasContent;
  const translationGuardReason = (() => {
    if (!hasOriginContent) {
      return localize(
        'sidebar_quick_translation_tooltip_no_origin',
        'Upload the manuscript to start translation.',
      );
    }
    if (!translationPrepReady) {
      return (
        getOriginPrepGuardMessage(originPrepSnapshot, localize) ??
        localize(
          'origin_prep_guard_generic',
          'Finish the manuscript prep steps before translating.',
        )
      );
    }
    return null;
  })();

  const proofreadingRunning =
    proofreadingAgentState.status === "running" ||
    proofreadingAgentState.status === "queued";
  const proofreadingDone = proofreadingAgentState.status === "done";
  const proofreadingFailed = proofreadingAgentState.status === "failed";
  const qualityRunning = qualityAgentState.status === "running";
  const qualityDone = qualityAgentState.status === "done";
  const qualityFailed = qualityAgentState.status === "failed";
  const hasProofResults = Boolean(
    proofreadingDone || snapshot.lifecycle.proofreading?.lastUpdatedAt,
  );

  const assistantPendingTooltip = localize(
    'sidebar_quick_tooltip_agent_pending',
    'The assistant is getting ready.',
  );

  const quickActions: QuickAction[] = [
    {
      key: "upload-origin",
      label: originReady
        ? localize('sidebar_quick_upload_label_done', 'Origin ready')
        : originAnalysisRunning
          ? localize(
              'sidebar_quick_upload_label_processing',
              'Analyzing origin…',
            )
          : localize('sidebar_quick_upload_label', 'Upload origin'),
      icon: <UploadCloud size={18} />,
      tooltip: !chatExecutorReady
        ? assistantPendingTooltip
        : originReady
          ? localize(
              'sidebar_quick_upload_tooltip_done',
              'The manuscript is already uploaded.',
            )
          : originAnalysisRunning
            ? localize(
                'sidebar_quick_upload_tooltip_processing',
                'Origin analysis is in progress.',
              )
            : translationRunning
              ? localize(
                  'sidebar_quick_upload_tooltip_running',
                  'You cannot change the manuscript while translation is running.',
                )
              : localize(
                  'sidebar_quick_upload_tooltip_default',
                  'Upload the manuscript file.',
                ),
      disabled:
        !chatExecutorReady ||
        originReady ||
        originAnalysisRunning ||
        translationRunning,
      status: originAnalysisRunning
        ? "running"
        : translationRunning
          ? "running"
          : originReady
            ? "done"
            : "default",
      onClick: async () => {
        if (
          !chatExecutorReady ||
          originReady ||
          originAnalysisRunning ||
          translationRunning
        )
          return;
        await chatActionExecute({
          type: "startUploadFile",
          reason: "sidebar-quick-action",
        });
      },
    },
    {
      key: "run-translation",
      label:
        translationDone || translationFailed
          ? localize('sidebar_quick_translation_label_redo', 'Redo translation')
          : localize('sidebar_quick_translation_label', 'Run translation'),
      icon: <RefreshCcw size={18} />,
      tooltip: !chatExecutorReady
        ? assistantPendingTooltip
        : translationGuardReason
          ? translationGuardReason
          : translationRunning
            ? localize(
                'sidebar_quick_translation_tooltip_running',
                'Translation is already running.',
              )
            : translationFailed
              ? localize(
                  'sidebar_quick_translation_tooltip_failed',
                  'The previous translation failed. Run it again.',
                )
              : translationDone
                ? localize(
                    'sidebar_quick_translation_tooltip_redo',
                    'Run translation again from the beginning.',
                  )
                : localize(
                    'sidebar_quick_translation_tooltip_default',
                    'Translate the entire manuscript.',
                  ),
      disabled:
        !chatExecutorReady || translationRunning || Boolean(translationGuardReason),
      status: translationRunning
        ? "running"
        : translationDone
          ? "done"
          : "default",
      onClick: async () => {
        if (
          !chatExecutorReady ||
          translationRunning ||
          translationGuardReason
        ) {
          return;
        }
        if (translationDone || translationFailed) {
          resetTranslation(activeProjectId ?? null);
        }
        await chatActionExecute({
          type: "startTranslation",
          allowParallel: false,
          label: null,
        });
      },
    },
    {
      key: "run-proofread",
      label:
        proofreadingDone || proofreadingFailed
          ? localize('sidebar_quick_proof_label_redo', 'Redo proofreading')
          : localize('sidebar_quick_proof_label', 'Run proofreading'),
      icon: <PenSquare size={18} />,
      tooltip: !chatExecutorReady
        ? assistantPendingTooltip
        : !hasTranslation
          ? localize(
              'sidebar_quick_proof_tooltip_no_translation',
              'Proofreading will be available once translation finishes.',
            )
          : proofreadingRunning
            ? localize(
                'sidebar_quick_proof_tooltip_running',
                'Proofreading is already running.',
              )
            : proofreadingFailed
              ? localize(
                  'sidebar_quick_proof_tooltip_failed',
                  'The previous proofreading run failed. Run it again.',
                )
              : proofreadingDone
                ? localize(
                    'sidebar_quick_proof_tooltip_redo',
                    'Run proofreading again to refresh the results.',
                  )
                : localize(
                    'sidebar_quick_proof_tooltip_default',
                    'Launch the proofreading workflow.',
                  ),
      disabled:
        !chatExecutorReady || !hasTranslation || proofreadingRunning,
      status: proofreadingRunning
        ? "running"
        : proofreadingDone
          ? "done"
          : "default",
      onClick: async () => {
        if (
          !chatExecutorReady ||
          !hasTranslation ||
          proofreadingRunning
        )
          return;
        if (proofreadingDone || proofreadingFailed) {
          resetProofreading(activeProjectId ?? null);
        }
        await chatActionExecute({
          type: "startProofread",
          allowParallel: false,
        });
      },
    },
    {
      key: "run-quality",
      label:
        qualityDone || qualityFailed
          ? localize('sidebar_quick_quality_label_redo', 'Redo quality review')
          : localize('sidebar_quick_quality_label', 'Run quality review'),
      icon: <ShieldCheck size={18} />,
      tooltip: !chatExecutorReady
        ? assistantPendingTooltip
        : !translationDone
          ? localize(
              'sidebar_quick_quality_tooltip_no_translation',
              'Quality review is available after translation completes.',
            )
          : qualityRunning
            ? localize(
                'sidebar_quick_quality_tooltip_running',
                'Quality review is currently running.',
              )
            : qualityFailed
              ? localize(
                  'sidebar_quick_quality_tooltip_failed',
                  'The previous quality review failed. Run it again.',
                )
              : qualityDone
                ? localize(
                    'sidebar_quick_quality_tooltip_redo',
                    'Run another quality review.',
                  )
                : localize(
                    'sidebar_quick_quality_tooltip_default',
                    'Perform the final quality check.',
                  ),
      disabled:
        !chatExecutorReady || !translationDone || qualityRunning,
      status: qualityRunning
        ? "running"
        : qualityDone
          ? "done"
          : "default",
      onClick: async () => {
        if (!chatExecutorReady || !translationDone || qualityRunning) return;
        if (qualityDone || qualityFailed) {
          resetQuality(activeProjectId ?? null);
        }
        await chatActionExecute({
          type: "startQuality",
          allowParallel: false,
        });
      },
    },
    {
      key: "view-proofread",
      label: localize('sidebar_quick_view_proof_label', 'View proofreading results'),
      icon: <Search size={18} />,
      tooltip: !chatExecutorReady
        ? assistantPendingTooltip
        : !proofreadingDone
          ? localize(
              'sidebar_quick_view_proof_tooltip_unavailable',
              'Proofreading results will appear once the run completes.',
            )
          : localize(
              'sidebar_quick_view_proof_tooltip',
              'Open the proofreading results.',
            ),
      status: proofreadingDone ? "done" : "default",
      disabled: !chatExecutorReady || !proofreadingDone || !hasProofResults,
      onClick: async () => {
        if (!chatExecutorReady || !proofreadingDone || !hasProofResults) return;
        await chatActionExecute({ type: "openProofreadTab" });
      },
    },
    {
      key: "open-export",
      label: localize('sidebar_quick_export_label', 'Open export panel'),
      icon: <BookOpen size={18} />,
      tooltip: !chatExecutorReady
        ? assistantPendingTooltip
        : translationDone
          ? localize(
              'sidebar_quick_export_tooltip_ready',
              'Open the eBook export panel.',
            )
          : localize(
              'sidebar_quick_export_tooltip_unavailable',
              'Export is available after translation is complete.',
            ),
      disabled: !chatExecutorReady || !translationDone,
      status: translationDone ? "done" : "default",
      onClick: async () => {
        if (!chatExecutorReady || !translationDone) return;
        await chatActionExecute({ type: "openExportPanel" });
      },
    },
    {
      key: "admin-dashboard",
      label: localize('sidebar_quick_admin_label', 'Admin dashboard'),
      icon: <ShieldCheck size={18} />,
      tooltip: localize(
        'sidebar_quick_admin_tooltip',
        'Open the proofreading monitoring dashboard.',
      ),
      disabled: false,
      status: "default",
      onClick: () => {
        navigate('/admin');
      },
    },
  ];

  if (isCollapsed) {
    return (
      <div className="flex h-full flex-col items-center gap-4 bg-white py-4 text-slate-600">
        <button
          type="button"
          onClick={toggleSidebar}
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-300 bg-white hover:border-indigo-400 hover:text-indigo-500"
          title={openSidebarTitle}
          aria-label={openSidebarTitle}
        >
          <ChevronRight size={16} />
        </button>
        <button
          type="button"
          onClick={() => setIsDialogOpen(true)}
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-300 bg-white hover:border-indigo-400 hover:text-indigo-500"
          title={newProjectTooltip}
          aria-label={newProjectTooltip}
          disabled={isCreating}
        >
          <NewProjectIcon size={16} />
        </button>
        {isDialogOpen && renderCreateDialog()}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-5 bg-white px-2 py-2 text-slate-900">
      <div className="flex items-center justify-between">
        <h2 className="text-lg text-slate-950">Soongi Pagers</h2>
        <button
          type="button"
          onClick={toggleSidebar}
          className="flex h-8 w-8 items-center justify-center rounded-md bg-white hover:text-indigo-500"
          title={closeSidebarTitle}
          aria-label={closeSidebarTitle}
        >
          <ChevronLeft size={16} />
        </button>
      </div>

      <div className="flex-1 pr-1 text-slate-800">
        <div className="flex h-full flex-col">
          <div className="flex-1 overflow-y-auto space-y-3">
            <Section
              title={activeSectionTitle}
              prepend={
                <NewProjectCard
                  onClick={() => setIsDialogOpen(true)}
                  label={newProjectLabel}
                />
              }
              projects={
                showAllActive
                  ? activeProjectsPrepared
                  : activeProjectsPrepared.slice(0, 5)
              }
              activeProjectId={activeProjectId}
              onSelect={(id, name) => {
                setActiveProject(id);
                setActiveProjectName(name ?? null);
              }}
              onRename={openRenameModal}
              onDelete={openDeleteModal}
              onComplete={handleCompleteProject}
              footer={
                activeProjectsPrepared.length > 5 && (
                  <button
                    type="button"
                    onClick={() => setShowAllActive((prev) => !prev)}
                    className="text-xs text-indigo-600 hover:underline"
                  >
                    {showAllActive ? showLessLabel : showMoreLabel}
                  </button>
                )
              }
            />
            {completedProjectsLimited.length > 0 && (
              <Section
                title={completedSectionTitle}
                projects={
                  showAllCompleted
                    ? completedProjectsLimited
                    : completedProjectsLimited.slice(0, 5)
                }
                activeProjectId={activeProjectId}
                onSelect={(id, name) => {
                  setActiveProject(id);
                  setActiveProjectName(name ?? null);
                }}
                onRename={openRenameModal}
                onDelete={openDeleteModal}
                onComplete={handleCompleteProject}
                footer={
                  completedProjectsLimited.length > 5 && (
                    <button
                      type="button"
                      onClick={() => setShowAllCompleted((prev) => !prev)}
                      className="text-xs text-indigo-600 hover:underline"
                    >
                      {showAllCompleted ? showLessLabel : showMoreLabel}
                    </button>
                  )
                }
              />
            )}
            {projects === undefined && (
              <p className="pt-10 text-center text-xs text-slate-500">
                {loadingLabel}
              </p>
            )}
            {projects !== undefined && projects.length === 0 && (
              <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-4 text-sm text-slate-700">
                <p className="font-semibold text-slate-800">
                  {localize(
                    "sidebar_empty_title",
                    "No projects are ready to start yet.",
                  )}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {localize(
                    "sidebar_empty_hint",
                    "Upload a manuscript file to kick off translation and proofreading.",
                  )}
                </p>
              </div>
            )}
            {projects &&
              projects.length > 0 &&
              activeProjectsLimited.length === 0 &&
              completedProjectsLimited.length === 0 && (
                <p className="pt-10 text-center text-xs text-slate-500">
                  {emptySearchMessage}
                </p>
              )}
          </div>

          {snapshot.projectId && (
            <div className="mt-3 space-y-3 border-t border-slate-100 pt-2">
              <SidebarQuickActions
                isOpen={quickActionsOpen}
                onToggle={(open) =>
                  setSidebarSection(projectScopeKey, "quickActions", open)
                }
                actions={quickActions}
                localize={localize}
              />
              <SidebarActivitySection
                isOpen={activitySectionOpen}
                onToggle={(open) =>
                  setSidebarSection(projectScopeKey, "activity", open)
                }
                items={recentUpdates}
              />
            </div>
          )}
        </div>
      </div>

      {isDialogOpen && renderCreateDialog()}
      {modalState?.type === "rename" && (
        <Modal
          title={localize('sidebar_project_modal_title', 'Project properties')}
          onClose={() => {
            if (modalState.submitting) return;
            closeModal();
          }}
          maxWidthClass="max-w-2xl"
        >
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submitRename();
            }}
          >
            <div className="flex flex-wrap items-center gap-3 text-xs font-semibold tracking-wide text-slate-500">
              <label htmlFor="project-name-input" className="whitespace-nowrap">
                {localize(
                  'sidebar_project_modal_field_name',
                  'Translation project name',
                )}
              </label>
              <input
                id="project-name-input"
                value={modalState.value}
                onChange={(event) =>
                  setModalState((prev) =>
                    prev && prev.type === "rename"
                      ? { ...prev, value: event.target.value }
                      : prev,
                  )
                }
                autoFocus
                className="w-60 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 focus:border-indigo-400 focus:outline-none"
              />
              <div className="relative ml-auto flex items-center gap-2 text-xs font-semibold text-slate-500">
                <span>{consentLabel}</span>
                <button
                  type="button"
                  onClick={() =>
                    setProfileField('copyrightConsent', !consentEnabled)
                  }
                  className={clsx(
                    'relative h-5 w-9 rounded-full border transition-colors duration-150',
                    consentEnabled
                      ? 'border-emerald-500 bg-emerald-500'
                      : 'border-slate-300 bg-slate-200',
                  )}
                  aria-pressed={consentEnabled}
                  aria-label={consentLabel}
                >
                  <span
                    className={clsx(
                      'absolute top-[2px] left-[2px] h-4 w-4 rounded-full bg-white transition-transform duration-150',
                      consentEnabled ? 'translate-x-4' : 'translate-x-0',
                    )}
                  />
                </button>
                <span
                  className={clsx(
                    'font-semibold',
                    consentEnabled
                      ? 'text-emerald-600'
                      : 'text-slate-400',
                  )}
                >
                  {consentStatusLabel}
                </span>
                <button
                  type="button"
                  onClick={() => setShowConsentInfo((prev) => !prev)}
                  className="text-slate-400 transition hover:text-slate-600"
                  aria-expanded={showConsentInfo}
                  aria-label={consentInfoToggleLabel}
                  title={consentInfoToggleLabel}
                >
                  <Info size={14} />
                </button>
                {showConsentInfo ? (
                  <div
                    className="absolute right-0 top-7 z-30 w-[22rem] rounded-md border border-slate-200 bg-white px-4 py-3 text-xs text-slate-700 shadow-lg"
                    role="dialog"
                    aria-label={consentInfoToggleLabel}
                  >
                    <p className="font-medium text-slate-600">{consentContent.intro}</p>
                    <div className="mt-3 space-y-2">
                      <div>
                        <p className="font-semibold text-slate-600">
                          {consentContent.needsConsentHeading}
                        </p>
                        <ul className="mt-1 list-disc space-y-1 pl-4 text-slate-600">
                          {consentContent.needsConsentItems.map((item, index) => (
                            <li key={`consent-need-${index}`}>{item}</li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <p className="font-semibold text-slate-600">
                          {consentContent.exceptionsHeading}
                        </p>
                        <ul className="mt-1 list-disc space-y-1 pl-4 text-slate-600">
                          {consentContent.exceptionsItems.map((item, index) => (
                            <li key={`consent-exception-${index}`}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-4 text-xs font-semibold tracking-wide text-slate-500">
              <span className="flex items-center gap-1">
                <span>{localize('sidebar_project_modal_origin_lang', 'Origin language')}</span>
                <span className="font-normal text-slate-700">
                  {modalState.project.origin_lang}
                </span>
              </span>
              <span className="flex items-center gap-1">
                <span>{localize('sidebar_project_modal_target_lang', 'Target language')}</span>
                <span className="font-normal text-slate-700">
                  {modalState.project.target_lang}
                </span>
              </span>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-4">
                <label
                  className="flex items-center gap-3 text-xs font-semibold tracking-wide text-slate-500"
                  htmlFor="project-book-title-original"
                >
                  <span className="whitespace-nowrap">
                    {localize(
                      'project_profile_field_book_title',
                      'Original title',
                    )}
                  </span>
                  <input
                    id="project-book-title-original"
                    value={modalState.profile.bookTitleOriginal}
                    onChange={(event) =>
                      setProfileField('bookTitleOriginal', event.target.value)
                    }
                    className="w-64 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                    placeholder={localize(
                      'project_profile_placeholder_book_title',
                      'e.g., Korean title',
                    )}
                  />
                </label>
                <label
                  className="flex items-center gap-3 text-xs font-semibold tracking-wide text-slate-500"
                  htmlFor="project-author-original"
                >
                  <span className="whitespace-nowrap">
                    {localize('project_profile_field_author', 'Author (original)')}
                  </span>
                  <input
                    id="project-author-original"
                    value={modalState.profile.authorName}
                    onChange={(event) =>
                      setProfileField('authorName', event.target.value)
                    }
                    className="w-64 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                    placeholder={localize(
                      'project_profile_placeholder_author',
                      'e.g., Hong Gildong',
                    )}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs font-semibold tracking-wide text-slate-500">
                  {localize('project_profile_field_author_notes', 'Author notes')}
                  <textarea
                    value={modalState.profile.authorNotes}
                    onChange={(event) =>
                      setProfileField('authorNotes', event.target.value)
                    }
                    rows={4}
                    className="w-72 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                    placeholder={localize(
                      'project_profile_placeholder_author_notes',
                      'Capture author intent, background, or notes for readers.',
                    )}
                  />
                </label>
              </div>
              <div className="space-y-4">
                <label
                  className="flex items-center gap-3 text-xs font-semibold tracking-wide text-slate-500"
                  htmlFor="project-book-title-english"
                >
                  <span className="whitespace-nowrap">
                    {localize(
                      'project_profile_field_book_title_en',
                      'Translated title*',
                    )}
                  </span>
                  <input
                    id="project-book-title-english"
                    value={modalState.profile.bookTitleEnglish}
                    onChange={(event) =>
                      setProfileField('bookTitleEnglish', event.target.value)
                    }
                    className="w-64 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                    placeholder={localize(
                      'project_profile_placeholder_book_title_en',
                      'e.g., English Title',
                    )}
                  />
                </label>
                <label
                  className="flex items-center gap-3 text-xs font-semibold tracking-wide text-slate-500"
                  htmlFor="project-translator-name"
                >
                  <span className="whitespace-nowrap">
                    {localize('project_profile_field_translator', 'Translator')}
                  </span>
                  <input
                    id="project-translator-name"
                    value={modalState.profile.translatorName}
                    onChange={(event) =>
                      setProfileField('translatorName', event.target.value)
                    }
                    className="w-64 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                    placeholder={localize(
                      'project_profile_placeholder_translator',
                      'e.g., Translator name',
                    )}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs font-semibold tracking-wide text-slate-500">
                  {localize(
                    'project_profile_field_translator_notes',
                    'Translator notes',
                  )}
                  <textarea
                    value={modalState.profile.translatorNotes}
                    onChange={(event) =>
                      setProfileField('translatorNotes', event.target.value)
                    }
                    rows={4}
                    className="w-72 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                    placeholder={localize(
                      'project_profile_placeholder_translator_notes',
                      'Share context or reminders for the translation team.',
                    )}
                  />
                </label>
              </div>
            </div>
            <div className="space-y-1 text-xs text-slate-600">
              <p>
                <span className="font-semibold text-slate-700">
                  {localize('sidebar_project_modal_project_id', 'Project ID:')}
                </span>{" "}
                <span className="font-mono text-slate-800">
                  {modalState.project.project_id}
                </span>
              </p>
              <p>
                <span className="font-semibold text-slate-700">
                  {localize('sidebar_project_modal_created', 'Created:')}
                </span>{" "}
                {formatDateTime(modalState.project.created_at)}
              </p>
            </div>
            <div className="space-y-1 text-xs text-slate-600">
              <p className="font-semibold text-slate-700">
                {localize('sidebar_project_modal_usage_title', 'Token usage')}
              </p>
              {isUsageLoading && (
                <p>{localize('common_loading', 'Loading…')}</p>
              )}
              {!isUsageLoading && modalUsageData && (
                <div className="space-y-1">
                  <p>
                    {localize(
                      'sidebar_project_modal_usage_total',
                      'Total tokens: {{total}} (input {{input}}, output {{output}})',
                      {
                        total: formatNumber(
                          modalUsageData.projectTotals.inputTokens +
                            modalUsageData.projectTotals.outputTokens,
                        ),
                        input: formatNumber(
                          modalUsageData.projectTotals.inputTokens,
                        ),
                        output: formatNumber(
                          modalUsageData.projectTotals.outputTokens,
                        ),
                      },
                    )}
                  </p>
                  {modalUsageData.eventsByType.map((event) => {
                    const total = event.inputTokens + event.outputTokens;
                    const labelMeta = usageEventLabelMessages[event.eventType];
                    const label = labelMeta
                      ? localize(labelMeta.key, labelMeta.fallback)
                      : event.eventType;
                    return (
                      <p key={event.eventType}>
                        {localize(
                          'sidebar_project_modal_usage_event',
                          '{{label}}: {{total}} (input {{input}}, output {{output}})',
                          {
                            label,
                            total: formatNumber(total),
                            input: formatNumber(event.inputTokens),
                            output: formatNumber(event.outputTokens),
                          },
                        )}
                      </p>
                    );
                  })}
                </div>
              )}
              {!isUsageLoading && !modalUsageData && (
                <p>
                  {localize(
                    'sidebar_project_modal_usage_empty',
                    'No usage data available.',
                  )}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  if (modalState.submitting) return;
                  closeModal();
                }}
                className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:border-slate-400 hover:text-slate-900"
                disabled={modalState.submitting}
              >
                {localize('common_cancel', 'Cancel')}
              </button>
              <button
                type="submit"
                className="rounded-md bg-indigo-500 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-400 disabled:opacity-60"
                disabled={modalState.submitting}
              >
                {modalState.submitting
                  ? localize('sidebar_project_modal_saving', 'Saving…')
                  : localize('sidebar_project_modal_save', 'Save changes')}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {modalState?.type === "delete" && (
        <Modal
          title={localize('sidebar_project_delete_title', 'Delete project')}
          description={localize(
            'sidebar_project_delete_description',
            'You can restore deleted projects within 7 days.',
          )}
          onClose={() => {
            if (modalState.submitting) return;
            closeModal();
          }}
        >
          <div className="space-y-4 text-sm text-slate-600">
            <p>
              {localize(
                'sidebar_project_delete_prompt',
                'Do you want to delete "{{title}}"?',
                { title: modalState.project.title || localize('sidebar_project_untitled', 'Untitled') },
              )}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  if (modalState.submitting) return;
                  closeModal();
                }}
                className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:border-slate-400 hover:text-slate-900"
                disabled={modalState.submitting}
              >
                {localize('common_cancel', 'Cancel')}
              </button>
              <button
                type="button"
                onClick={() => void submitDelete()}
                className="rounded-md bg-red-500 px-3 py-2 text-sm font-semibold text-white hover:bg-red-400 disabled:opacity-60"
                disabled={modalState.submitting}
              >
                {modalState.submitting
                  ? localize('sidebar_project_delete_submitting', 'Deleting…')
                  : localize('sidebar_project_delete_confirm', 'Delete')}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {toast && (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-40 -translate-x-1/2">
          <div className="pointer-events-auto rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 shadow-lg">
            {toast.message}
          </div>
        </div>
      )}
    </div>
  );
};

interface SectionProps {
  title: string;
  projects: ProjectSummary[];
  activeProjectId: string | null;
  onSelect: (id: string, name?: string | null) => void;
  onRename: (project: ProjectSummary) => Promise<void> | void;
  onDelete: (project: ProjectSummary) => Promise<void> | void;
  onComplete: (project: ProjectSummary) => Promise<void> | void;
  prepend?: React.ReactNode;
  footer?: React.ReactNode;
}

const Section = ({
  title,
  projects,
  activeProjectId,
  onSelect,
  onRename,
  onDelete,
  onComplete,
  prepend,
  footer,
}: SectionProps) => {
  if (!projects.length && !prepend) return null;

  return (
    <div className="space-y-1.5">
      {title ? (
        <p className="px-1 text-[11px] font-medium text-slate-600">{title}</p>
      ) : null}
      <div className="space-y-1.5">
        {prepend}
        {projects.map((project) => (
          <SidebarProjectButton
            key={project.project_id}
            project={project}
            active={project.project_id === activeProjectId}
            onSelect={onSelect}
            onRename={() => onRename(project)}
            onDelete={() => onDelete(project)}
            onComplete={() => onComplete(project)}
          />
        ))}
      </div>
      {footer && <div className="px-1 text-right">{footer}</div>}
    </div>
  );
};

const NewProjectCard = ({
  onClick,
  label,
}: {
  onClick: () => void;
  label: string;
}) => (
  <button
    type="button"
    onClick={onClick}
    className="group flex w-full items-center gap-3 rounded-xl bg-white px-3 py-2 text-left text-sm text-slate-600 transition hover:bg-indigo-50 hover:text-indigo-500"
  >
    <NewProjectIcon size={18} className="text-slate-400 transition group-hover:text-indigo-500" />
    <span className="text-sm font-medium text-slate-900">{label}</span>
  </button>
);
