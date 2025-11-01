import { create } from "zustand";
import type { ProjectMeta, ProjectSummary } from "../types/domain";

interface ProjectState {
  projects: ProjectSummary[];
  activeProjectId: string | null;
  activeProjectName: string | null;
  recentIds: string[];
  setProjects: (projects: ProjectSummary[]) => void;
  setActiveProject: (projectId: string | null) => void;
  setActiveProjectName: (name: string | null) => void;
  purgeProject: (projectId: string) => void;
  updateProjectMeta: (projectId: string, meta: ProjectMeta) => void;
}

const RECENT_STORAGE_KEY = "project-t1.web.recent-projects";
const ACTIVE_PROJECT_ID_KEY = "project-t1.web.active-project-id";
const ACTIVE_PROJECT_NAME_KEY = "project-t1.web.active-project-name";

const loadStoredIds = (key: string): string[] => {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch (error) {
    console.warn(`[project.store] Failed to parse ${key}`, error);
    return [];
  }
};

const persistIds = (key: string, ids: string[]) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(ids));
  } catch (error) {
    console.warn(`[project.store] Failed to persist ${key}`, error);
  }
};

const loadStoredString = (key: string): string | null => {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(key);
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
    return null;
  } catch (error) {
    console.warn(`[project.store] Failed to read ${key}`, error);
    return null;
  }
};

const persistString = (key: string, value: string | null) => {
  if (typeof window === "undefined") return;
  try {
    if (value && value.trim().length > 0) {
      window.localStorage.setItem(key, value);
    } else {
      window.localStorage.removeItem(key);
    }
  } catch (error) {
    console.warn(`[project.store] Failed to persist ${key}`, error);
  }
};

const normalizeProjectMeta = (meta: ProjectSummary["meta"]): ProjectMeta => {
  if (!meta) return {};
  if (typeof meta === "string") {
    try {
      return JSON.parse(meta) as ProjectMeta;
    } catch (error) {
      console.warn(
        "[project.store] Failed to parse project meta string",
        error,
      );
      return {};
    }
  }
  if (typeof meta === "object") return meta as ProjectMeta;
  return {};
};

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  activeProjectId: loadStoredString(ACTIVE_PROJECT_ID_KEY),
  activeProjectName: loadStoredString(ACTIVE_PROJECT_NAME_KEY),
  recentIds: loadStoredIds(RECENT_STORAGE_KEY),
  setProjects: (projects) =>
    set({
      projects: projects.map((project) => ({
        ...project,
        meta: normalizeProjectMeta(project.meta),
      })),
    }),
  setActiveProject: (projectId) =>
    set((state) => {
      persistString(ACTIVE_PROJECT_ID_KEY, projectId);
      if (!projectId) {
        return { activeProjectId: null };
      }
      const nextRecent = [
        projectId,
        ...state.recentIds.filter((id) => id !== projectId),
      ].slice(0, 20);
      persistIds(RECENT_STORAGE_KEY, nextRecent);
      return {
        activeProjectId: projectId,
        recentIds: nextRecent,
      };
    }),
  setActiveProjectName: (name) => {
    persistString(ACTIVE_PROJECT_NAME_KEY, name);
    set({ activeProjectName: name });
  },
  purgeProject: (projectId) => {
    const { recentIds, activeProjectId, activeProjectName } = get();
    const nextRecent = recentIds.filter((id) => id !== projectId);
    persistIds(RECENT_STORAGE_KEY, nextRecent);
    set({
      recentIds: nextRecent,
      activeProjectId: activeProjectId === projectId ? null : activeProjectId,
      activeProjectName:
        activeProjectId === projectId ? null : activeProjectName,
    });
    if (activeProjectId === projectId) {
      persistString(ACTIVE_PROJECT_ID_KEY, null);
      persistString(ACTIVE_PROJECT_NAME_KEY, null);
    }
  },
  updateProjectMeta: (projectId, meta) => {
    set((state) => ({
      projects: state.projects.map((project) =>
        project.project_id === projectId
          ? {
              ...project,
              meta,
            }
          : project,
      ),
    }));
  },
}));
