import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "../store/auth.store";
import { useProjectStore } from "../store/project.store";
import { api } from "../services/api";
import type { ChatHistoryItem } from "../types/domain";

export const chatKeys = {
  history: (projectId: string) => ["chat-history", projectId] as const,
};

export const useChatHistory = (projectId: string | null) => {
  const token = useAuthStore((state) => state.token);
  const projectExists = useProjectStore((state) =>
    projectId
      ? state.projects.some((project) => project.project_id === projectId)
      : false,
  );

  return useQuery<ChatHistoryItem[]>({
    queryKey: projectId
      ? chatKeys.history(projectId)
      : ["chat-history", "__empty__"],
    enabled: Boolean(token && projectId && projectExists),
    queryFn: async () => {
      if (!token || !projectId) return [];
      return api.chatHistory(token, projectId);
    },
    staleTime: 15_000,
  });
};
