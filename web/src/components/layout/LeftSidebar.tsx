import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  UploadCloud,
  RefreshCcw,
  PenSquare,
  ShieldCheck,
  Search,
  BookOpen,
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

const languageOptions = [
  "Korean",
  "English",
  "Japanese",
  "Chinese",
  "Spanish",
  "French",
  "German",
];

const usageEventLabels: Record<string, string> = {
  translate: "Translation",
  quality: "Quality",
  proofread: "Proofread",
  ebook: "eBook",
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

export const LeftSidebar = () => {
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
  const queryClient = useQueryClient();
  const { locale } = useUILocale();
  const localize = useCallback(
    (key: string, fallback: string) => {
      const resolved = translate(key, locale);
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
      }
    | { type: "delete"; project: ProjectSummary; submitting: boolean }
    | null
  >(null);
  const [toast, setToast] = useState<{ id: number; message: string } | null>(
    null,
  );

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
    setModalState({
      type: "rename",
      project,
      value: project.title ?? "",
      submitting: false,
    });
  }, []);

  const openDeleteModal = useCallback((project: ProjectSummary) => {
    setModalState({ type: "delete", project, submitting: false });
  }, []);

  const closeModal = useCallback(() => {
    setModalState(null);
  }, []);

  const submitRename = useCallback(async () => {
    if (!modalState || modalState.type !== "rename") return;
    if (!token) {
      window.alert("로그인이 필요합니다. 다시 로그인해 주세요.");
      return;
    }

    const trimmed = modalState.value.trim();
    if (!trimmed) {
      window.alert("프로젝트 이름은 비워둘 수 없습니다.");
      return;
    }
    if (trimmed === (modalState.project.title ?? "")) {
      closeModal();
      return;
    }

    setModalState({ ...modalState, submitting: true });
    try {
      await api.updateProject(token, modalState.project.project_id, {
        title: trimmed,
      });
      if (modalState.project.project_id === activeProjectId) {
        setActiveProjectName(trimmed);
      }
      await invalidateProjects();
      await invalidateProjectContent(modalState.project.project_id);
      showToast("프로젝트 이름이 변경되었습니다.");
      closeModal();
    } catch (error) {
      console.error("[sidebar] failed to rename project", error);
      window.alert("프로젝트 이름 변경에 실패했습니다. 다시 시도해 주세요.");
      setModalState((prev) =>
        prev && prev.type === "rename" ? { ...prev, submitting: false } : prev,
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
  ]);

  const submitDelete = useCallback(async () => {
    if (!modalState || modalState.type !== "delete") return;
    if (!token) {
      window.alert("로그인이 필요합니다. 다시 로그인해 주세요.");
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
      showToast("프로젝트가 삭제되었습니다. 7일 동안 복구할 수 있습니다.");
      closeModal();
    } catch (error) {
      console.error("[sidebar] failed to delete project", error);
      window.alert("프로젝트 삭제에 실패했습니다. 다시 시도해 주세요.");
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
        <h2 className="text-lg font-semibold text-slate-900">New project</h2>
        <p className="mt-1 text-sm text-slate-500">
          Name your project and choose languages to get started.
        </p>

        <label className="mt-4 block text-xs font-semibold tracking-wide text-slate-500">
          Title
          <input
            value={newProjectTitle}
            onChange={(event) => setNewProjectTitle(event.target.value)}
            placeholder="New project"
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-400 focus:outline-none"
          />
        </label>

        <div className="mt-4 grid grid-cols-2 gap-4">
          <label className="text-xs font-semibold tracking-wide text-slate-500">
            Origin language
            <select
              value={originLang}
              onChange={(event) => setOriginLang(event.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-indigo-400 focus:outline-none"
            >
              {languageOptions.map((language) => (
                <option key={language} value={language}>
                  {language}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-semibold tracking-wide text-slate-500">
            Target language
            <select
              value={targetLang}
              onChange={(event) => setTargetLang(event.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-indigo-400 focus:outline-none"
            >
              {languageOptions.map((language) => (
                <option key={language} value={language}>
                  {language}
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
            Cancel
          </button>
          <button
            type="submit"
            disabled={isCreating}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-indigo-300"
          >
            {isCreating ? "Creating…" : "Create"}
          </button>
        </footer>
      </form>
    </div>
  );

  const handleCompleteProject = useCallback(
    async (project: ProjectSummary) => {
      if (!token) {
        window.alert("로그인이 필요합니다. 다시 로그인해 주세요.");
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
        window.alert("프로젝트 완료 처리에 실패했습니다. 다시 시도해 주세요.");
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

  const activeProjectSummary = activeProjectId
    ? projectMap.get(activeProjectId) ?? null
    : null;
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
        window.alert("새 프로젝트 생성에 실패했습니다. 다시 시도해 주세요.");
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

  const recentUpdates = useMemo(() => {
    const lines: Array<{ id: string; text: string }> = [];
    const pushUpdate = (
      id: string,
      label: string,
      timestamp?: string | null,
    ) => {
      const formatted = formatRecentTimestamp(timestamp);
      if (!formatted) return;
      lines.push({ id, text: `${label} 최근 업데이트: ${formatted}` });
    };

    pushUpdate("origin", "원문", snapshot.origin.lastUpdatedAt);
    pushUpdate(
      "translation",
      "번역",
      snapshot.translation.lastUpdatedAt ??
        snapshot.lifecycle.translation?.lastUpdatedAt ??
        null,
    );
    pushUpdate(
      "proofreading",
      "교정",
      snapshot.lifecycle.proofreading?.lastUpdatedAt ?? null,
    );
    pushUpdate(
      "quality",
      "품질 평가",
      snapshot.lifecycle.quality?.lastUpdatedAt ?? null,
    );
    pushUpdate(
      "publishing",
      "전자책",
      snapshot.lifecycle.publishing?.lastUpdatedAt ?? null,
    );

    return lines;
  }, [snapshot]);

  const originReady = snapshot.origin.hasContent;
  const translationRunning =
    translationAgentState.status === "running" ||
    translationAgentState.status === "queued";
  const translationDone =
    translationAgentState.status === "done" || snapshot.translation.hasContent;
  const translationFailed = translationAgentState.status === "failed";
  const hasTranslation = snapshot.translation.hasContent;

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

  const quickActions: QuickAction[] = [
    {
      key: "upload-origin",
      label: "원문 업로드",
      icon: <UploadCloud size={18} />,
      tooltip: !chatExecutorReady
        ? "챗봇이 준비되는 중입니다."
        : originReady
          ? "원문이 이미 업로드되었습니다."
          : translationRunning
            ? "번역이 진행 중일 때는 원문을 변경할 수 없습니다."
            : "원문 파일을 업로드합니다.",
      disabled: !chatExecutorReady || originReady || translationRunning,
      status: translationRunning
        ? "running"
        : originReady
          ? "done"
          : "default",
      onClick: async () => {
        if (!chatExecutorReady || originReady || translationRunning) return;
        await chatActionExecute({
          type: "startUploadFile",
          reason: "sidebar-quick-action",
        });
      },
    },
    {
      key: "run-translation",
      label:
        translationDone || translationFailed ? "번역 다시 실행" : "번역 실행",
      icon: <RefreshCcw size={18} />,
      tooltip: !chatExecutorReady
        ? "챗봇이 준비되는 중입니다."
        : !originReady
          ? "원문을 업로드하면 실행할 수 있습니다."
          : translationRunning
            ? "번역이 진행 중입니다."
            : translationFailed
              ? "이전 번역이 실패했습니다. 다시 실행해 주세요."
              : translationDone
                ? "번역을 다시 실행합니다."
                : "전체 원문을 번역합니다.",
      disabled:
        !chatExecutorReady || translationRunning || !originReady,
      status: translationRunning
        ? "running"
        : translationDone
          ? "done"
          : "default",
      onClick: async () => {
        if (!chatExecutorReady || translationRunning || !originReady) return;
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
        proofreadingDone || proofreadingFailed ? "교정 다시 실행" : "교정 실행",
      icon: <PenSquare size={18} />,
      tooltip: !chatExecutorReady
        ? "챗봇이 준비되는 중입니다."
        : !hasTranslation
          ? "번역이 완료되면 사용할 수 있습니다."
          : proofreadingRunning
            ? "교정이 진행 중입니다."
            : proofreadingFailed
              ? "이전 교정이 실패했습니다. 다시 실행해 주세요."
              : proofreadingDone
                ? "교정을 다시 실행합니다."
                : "교정 워크플로를 실행합니다.",
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
        qualityDone || qualityFailed ? "품질 평가 다시 실행" : "품질 평가 실행",
      icon: <ShieldCheck size={18} />,
      tooltip: !chatExecutorReady
        ? "챗봇이 준비되는 중입니다."
        : !translationDone
          ? "번역이 완료되면 사용할 수 있습니다."
          : qualityRunning
            ? "품질 평가가 진행 중입니다."
            : qualityFailed
              ? "이전 품질 평가가 실패했습니다. 다시 실행해 주세요."
              : qualityDone
                ? "품질 평가를 다시 실행합니다."
                : "최종 품질 검사를 실행합니다.",
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
      label: "교정 보기",
      icon: <Search size={18} />,
      tooltip: !chatExecutorReady
        ? "챗봇이 준비되는 중입니다."
        : !proofreadingDone
          ? "교정이 완료되면 확인할 수 있습니다."
          : "교정 결과를 확인합니다.",
      status: proofreadingDone ? "done" : "default",
      disabled: !chatExecutorReady || !proofreadingDone || !hasProofResults,
      onClick: async () => {
        if (!chatExecutorReady || !proofreadingDone || !hasProofResults) return;
        await chatActionExecute({ type: "openProofreadTab" });
      },
    },
    {
      key: "open-export",
      label: "전자책 내보내기",
      icon: <BookOpen size={18} />,
      tooltip: !chatExecutorReady
        ? "챗봇이 준비되는 중입니다."
        : translationDone
          ? "전자책 내보내기 패널을 엽니다."
          : "번역이 완료되면 사용할 수 있습니다.",
      disabled: !chatExecutorReady || !translationDone,
      status: translationDone ? "done" : "default",
      onClick: async () => {
        if (!chatExecutorReady || !translationDone) return;
        await chatActionExecute({ type: "openExportPanel" });
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
          title="Open sidebar"
        >
          <ChevronRight size={16} />
        </button>
        <button
          type="button"
          onClick={() => setIsDialogOpen(true)}
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-300 bg-white hover:border-indigo-400 hover:text-indigo-500"
          title="New translation project"
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
          title="Close sidebar"
        >
          <ChevronLeft size={16} />
        </button>
      </div>

      <div className="flex-1 pr-1 text-slate-800">
        <div className="flex h-full flex-col">
          <div className="flex-1 overflow-y-auto space-y-3">
            <Section
              title="Active Projects"
              prepend={<NewProjectCard onClick={() => setIsDialogOpen(true)} />}
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
                    {showAllActive ? "Show less" : "... Show more"}
                  </button>
                )
              }
            />
            {completedProjectsLimited.length > 0 && (
              <Section
                title="Completed Projects"
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
                      {showAllCompleted ? "Show less" : "... Show more"}
                    </button>
                  )
                }
              />
            )}
            {projects === undefined && (
              <p className="pt-10 text-center text-xs text-slate-500">
                {translate("loading")}
              </p>
            )}
            {projects !== undefined && projects.length === 0 && (
              <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-4 text-sm text-slate-700">
                <p className="font-semibold text-slate-800">
                  {localize("sidebar_empty_title", "시작할 프로젝트가 없습니다.")}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {localize(
                    "sidebar_empty_hint",
                    "원문 파일을 업로드하면 번역과 교정을 바로 시작할 수 있습니다.",
                  )}
                </p>
              </div>
            )}
            {projects &&
              projects.length > 0 &&
              activeProjectsLimited.length === 0 &&
              completedProjectsLimited.length === 0 && (
                <p className="pt-10 text-center text-xs text-slate-500">
                  검색 결과가 없습니다.
                </p>
              )}
          </div>

          {activeProjectSummary && (
            <div className="mt-3 space-y-3 border-t border-slate-100 pt-2">
              <SidebarQuickActions
                isOpen={quickActionsOpen}
                onToggle={(open) =>
                  setSidebarSection(projectScopeKey, "quickActions", open)
                }
            actions={quickActions}
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
          title="Project properties"
          description="Manage project details."
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
            <label
              className="text-xs font-semibold tracking-wide text-slate-500"
              htmlFor="project-name-input"
            >
              Name
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
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-400 focus:outline-none"
            />
            <div className="grid grid-cols-2 gap-4 text-sm text-slate-500">
              <div>
                <p className="text-xs font-semibold tracking-wide text-slate-500">
                  Origin language
                </p>
                <p className="mt-1 text-slate-700">
                  {modalState.project.origin_lang}
                </p>
              </div>
              <div>
                <p className="text-xs font-semibold tracking-wide text-slate-500">
                  Target language
                </p>
                <p className="mt-1 text-slate-700">
                  {modalState.project.target_lang}
                </p>
              </div>
            </div>
            <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
              <p>
                <span className="font-semibold text-slate-700">
                  Project ID:
                </span>{" "}
                <span className="font-mono text-slate-800">
                  {modalState.project.project_id}
                </span>
              </p>
              <p className="mt-1">
                <span className="font-semibold text-slate-700">Created:</span>{" "}
                {formatDateTime(modalState.project.created_at)}
              </p>
            </div>
            <div className="rounded-md border border-slate-200 bg-white px-3 py-3 text-xs">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Token Usage
              </p>
              {isUsageLoading && (
                <p className="mt-2 text-slate-500">Loading…</p>
              )}
              {!isUsageLoading && modalUsageData && (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-600">
                  <li>
                    Total tokens: {formatNumber(
                      modalUsageData.projectTotals.inputTokens +
                        modalUsageData.projectTotals.outputTokens,
                    )}{" "}
                    (input {formatNumber(modalUsageData.projectTotals.inputTokens)}, output {formatNumber(modalUsageData.projectTotals.outputTokens)})
                  </li>
                  {modalUsageData.eventsByType.map((event) => {
                    const total = event.inputTokens + event.outputTokens;
                    const label = usageEventLabels[event.eventType] ?? event.eventType;
                    return (
                      <li key={event.eventType}>
                        {label}: {formatNumber(total)} (input {formatNumber(event.inputTokens)}, output {formatNumber(event.outputTokens)})
                      </li>
                    );
                  })}
                </ul>
              )}
              {!isUsageLoading && !modalUsageData && (
                <p className="mt-2 text-slate-500">No usage data available.</p>
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
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-md bg-indigo-500 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-400 disabled:opacity-60"
                disabled={modalState.submitting}
              >
                {modalState.submitting ? "Saving…" : "Save changes"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {modalState?.type === "delete" && (
        <Modal
          title="프로젝트 삭제"
          description="삭제된 프로젝트는 7일 동안 복구할 수 있습니다."
          onClose={() => {
            if (modalState.submitting) return;
            closeModal();
          }}
        >
          <div className="space-y-4 text-sm text-slate-600">
            <p>
              <strong>{modalState.project.title || "제목 없음"}</strong>{" "}
              프로젝트를 삭제하시겠습니까?
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
                취소
              </button>
              <button
                type="button"
                onClick={() => void submitDelete()}
                className="rounded-md bg-red-500 px-3 py-2 text-sm font-semibold text-white hover:bg-red-400 disabled:opacity-60"
                disabled={modalState.submitting}
              >
                {modalState.submitting ? "삭제 중..." : "삭제"}
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

const NewProjectCard = ({ onClick }: { onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    className="group flex w-full items-center gap-3 rounded-xl bg-white px-3 py-2 text-left text-sm text-slate-600 transition hover:bg-indigo-50 hover:text-indigo-500"
  >
    <NewProjectIcon size={18} className="text-slate-400 transition group-hover:text-indigo-500" />
    <span className="text-sm font-medium text-slate-900">New project</span>
  </button>
);
