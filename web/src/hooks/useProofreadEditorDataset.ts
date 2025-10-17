import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../services/api";
import type { ProofreadEditorResponse } from "../types/domain";

interface UseProofreadEditorDatasetParams {
  token: string | null;
  projectId: string | null;
  jobId?: string | null;
  translationFileId?: string | null;
}

export const proofreadEditorKeys = {
  base: (projectId: string | null) => ["proofread-editor", projectId] as const,
  dataset: (
    projectId: string | null,
    jobId?: string | null,
    translationFileId?: string | null,
  ) =>
    ["proofread-editor", projectId, jobId ?? null, translationFileId ?? null] as const,
};

export const useProofreadEditorDataset = ({
  token,
  projectId,
  jobId,
  translationFileId,
}: UseProofreadEditorDatasetParams) =>
  useQuery<ProofreadEditorResponse | null>({
    queryKey: proofreadEditorKeys.dataset(projectId, jobId ?? null, translationFileId ?? null),
    queryFn: async () => {
      if (!token || !projectId) {
        throw new Error("Missing authentication or projectId");
      }
      try {
        return await api.fetchProofreadEditorDataset({
          projectId,
          token,
          jobId,
          translationFileId,
        });
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          return null;
        }
        throw error;
      }
    },
    enabled: Boolean(token && projectId),
    staleTime: 30_000,
  });
