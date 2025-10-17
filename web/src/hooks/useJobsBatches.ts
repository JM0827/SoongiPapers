import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "../store/auth.store";
import { api } from "../services/api";

export const useUsage = (projectId: string | null) => {
  const token = useAuthStore((state) => state.token);

  return useQuery({
    queryKey: ["usage", projectId],
    enabled: Boolean(token && projectId),
    queryFn: async () => {
      if (!token || !projectId) throw new Error("Missing token or project id");
      return api.usage(token, projectId);
    },
    staleTime: 30_000,
  });
};
