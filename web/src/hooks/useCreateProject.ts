import { useCallback, useState } from "react";
import { useAuthStore } from "../store/auth.store";
import { useProjectStore } from "../store/project.store";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../services/api";
import { projectKeys } from "./useProjectData";
import type { ProjectSummary } from "../types/domain";

const buildDefaultTitle = () => {
  const now = new Date();
  const formatted = now
    .toLocaleString("ko-KR", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
    .replace(/\./g, "")
    .replace(/\s+/g, "")
    .replace(/:/g, "");
  return `번역 ${formatted}`;
};

interface CreateProjectOptions {
  title?: string;
  originLang?: string;
  targetLang?: string;
}

export const useCreateProject = () => {
  const token = useAuthStore((state) => state.token);
  const setActiveProject = useProjectStore((state) => state.setActiveProject);
  const setActiveProjectName = useProjectStore(
    (state) => state.setActiveProjectName,
  );
  const queryClient = useQueryClient();
  const [isCreating, setIsCreating] = useState(false);

  const createProject = useCallback(
    async (options: CreateProjectOptions = {}): Promise<ProjectSummary> => {
      if (!token) {
        throw new Error("로그인 정보가 없습니다. 다시 로그인해 주세요.");
      }

      setIsCreating(true);
      try {
        const payload = {
          title: options.title ?? buildDefaultTitle(),
          origin_lang: options.originLang ?? "Korean",
          target_lang: options.targetLang ?? "English",
        };

        const response = await api.createProject(token, payload);
        const project = response.project;
        setActiveProject(project.project_id);
        setActiveProjectName(project.title ?? null);
        await queryClient.invalidateQueries({ queryKey: projectKeys.list });
        return project;
      } finally {
        setIsCreating(false);
      }
    },
    [token, setActiveProject, setActiveProjectName, queryClient],
  );

  return { createProject, isCreating };
};
