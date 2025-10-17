import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "../store/auth.store";
import { api } from "../services/api";
import { useProjectStore } from "../store/project.store";
import type { ProjectContent, WorkflowSummary } from "../types/domain";

export const projectKeys = {
  list: ["projects"] as const,
  usage: (projectId: string) => ["usage", projectId] as const,
  content: (projectId: string) => ["project-content", projectId] as const,
  qualityHistory: (projectId: string) =>
    ["quality-history", projectId] as const,
  jobs: (projectId: string) => ["project-jobs", projectId] as const,
  workflow: (projectId: string) => ["workflow-summary", projectId] as const,
};

export const useProjectList = () => {
  const token = useAuthStore((state) => state.token);
  const setProjects = useProjectStore((state) => state.setProjects);
  const activeProjectId = useProjectStore((state) => state.activeProjectId);
  const setActiveProject = useProjectStore((state) => state.setActiveProject);
  const setActiveProjectName = useProjectStore(
    (state) => state.setActiveProjectName,
  );

  return useQuery({
    queryKey: projectKeys.list,
    enabled: Boolean(token),
    queryFn: async () => {
      if (!token) return [];
      const projects = await api.listProjects(token);
      setProjects(projects);
      if (
        activeProjectId &&
        !projects.some((project) => project.project_id === activeProjectId)
      ) {
        setActiveProject(null);
        setActiveProjectName(null);
      }
      return projects;
    },
  });
};

interface UseProjectContentOptions {
  enabled?: boolean;
  staleTime?: number;
}

export const useProjectContent = (
  projectId: string | null,
  options: UseProjectContentOptions = {},
) => {
  const token = useAuthStore((state) => state.token);
  const { enabled = true, staleTime = 15_000 } = options;

  return useQuery<ProjectContent | null>({
    queryKey: projectId
      ? projectKeys.content(projectId)
      : ["project-content", "__empty__"],
    enabled: Boolean(token && projectId && enabled),
    queryFn: async () => {
      if (!token || !projectId) return null;
      return api.projectContent(token, projectId);
    },
    staleTime,
  });
};

export const useQualityHistory = (projectId: string | null) => {
  const token = useAuthStore((state) => state.token);

  return useQuery({
    queryKey: projectId
      ? projectKeys.qualityHistory(projectId)
      : projectKeys.qualityHistory("__empty__"),
    enabled: Boolean(token && projectId),
    queryFn: async () => {
      if (!token || !projectId) return null;
      return api.qualityHistory(token, projectId);
    },
    staleTime: 60_000,
  });
};

export const useProjectJobs = (projectId: string | null) => {
  const token = useAuthStore((state) => state.token);

  return useQuery({
    queryKey: projectId
      ? projectKeys.jobs(projectId)
      : projectKeys.jobs("__empty__"),
    enabled: Boolean(token && projectId),
    queryFn: async () => {
      if (!token || !projectId) return [];
      const jobs = await api.listJobs(token, { projectId, limit: 25 });
      return jobs;
    },
    staleTime: 20_000,
  });
};

export const useWorkflowSummary = (projectId: string | null) => {
  const token = useAuthStore((state) => state.token);

  return useQuery<WorkflowSummary | null>({
    queryKey: projectId
      ? projectKeys.workflow(projectId)
      : projectKeys.workflow("__empty__"),
    enabled: Boolean(token && projectId),
    queryFn: async () => {
      if (!token || !projectId) return null;
      return api.workflowSummary(token, projectId);
    },
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
};
