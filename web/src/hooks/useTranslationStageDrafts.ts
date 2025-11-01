import { useQuery } from "@tanstack/react-query";
import { api } from "../services/api";
import type {
  TranslationStageDraftResponse,
  TranslationStageKey,
} from "../types/domain";

interface UseTranslationStageDraftsParams {
  token: string | null;
  projectId: string | null;
  jobId?: string | null;
  translationFileId?: string | null;
  stage: TranslationStageKey | null;
  enabled?: boolean;
}

export const translationStageDraftKeys = {
  base: (projectId: string | null) => ["stage-drafts", projectId] as const,
  detail: (
    projectId: string | null,
    jobId: string | null,
    translationFileId: string | null,
    stage: TranslationStageKey | null,
  ) =>
    [
      "stage-drafts",
      projectId,
      jobId ?? null,
      translationFileId ?? null,
      stage ?? null,
    ] as const,
};

export const useTranslationStageDrafts = ({
  token,
  projectId,
  jobId = null,
  translationFileId = null,
  stage,
  enabled = true,
}: UseTranslationStageDraftsParams) =>
  useQuery<TranslationStageDraftResponse | null>({
    queryKey: translationStageDraftKeys.detail(
      projectId,
      jobId,
      translationFileId,
      stage,
    ),
    queryFn: async () => {
      if (!token || !projectId || !stage) {
        throw new Error("Missing required parameters for stage drafts");
      }
      return api.fetchTranslationStageDrafts({
        token,
        projectId,
        stage,
        jobId,
        translationFileId,
      });
    },
    enabled: Boolean(
      enabled && token && projectId && stage && (jobId || translationFileId),
    ),
    staleTime: 60_000,
  });
