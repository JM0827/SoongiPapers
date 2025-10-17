import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../services/api";
import { useAuthStore } from "../store/auth.store";
import { useProjectStore } from "../store/project.store";
import { projectKeys } from "./useProjectData";
import type { ModelOption } from "../types/model";
import type { ProjectMeta } from "../types/domain";

const FALLBACK_MODELS: ModelOption[] = [
  {
    id: "gpt-4o-mini",
    label: "GPT-4o mini",
    provider: "openai",
    description: "빠르게 응답하며 대부분의 일반 업무에 적합한 기본 모델",
    latencyClass: "balanced",
    recommended: true,
    capabilityTags: ["general", "fast"],
  },
  {
    id: "gpt-4o",
    label: "GPT-4o",
    provider: "openai",
    description: "정밀한 문체 제어와 고품질 번역을 위한 상위 모델",
    latencyClass: "quality",
    capabilityTags: ["general", "creative"],
  },
];

const FALLBACK_DEFAULT_MODEL = "gpt-4o";

const normalizeProjectMeta = (
  meta: ProjectMeta | null | undefined | string,
): ProjectMeta => {
  if (!meta) return {};
  if (typeof meta === "string") {
    try {
      return JSON.parse(meta) as ProjectMeta;
    } catch (error) {
      console.warn(
        "[modelSelection] Failed to parse project meta string",
        error,
      );
      return {};
    }
  }
  if (typeof meta === "object") return meta as ProjectMeta;
  return {};
};

export const useModelSelection = () => {
  const token = useAuthStore((state) => state.token);
  const activeProjectId = useProjectStore((state) => state.activeProjectId);
  const projects = useProjectStore((state) => state.projects);
  const updateProjectMeta = useProjectStore((state) => state.updateProjectMeta);
  const queryClient = useQueryClient();

  const {
    data: modelResponse,
    isLoading: isModelsLoading,
    isError,
  } = useQuery({
    queryKey: ["models"],
    enabled: Boolean(token),
    staleTime: 60_000,
    queryFn: async () => {
      if (!token) return null;
      return api.listModels(token);
    },
    retry: 1,
  });

  const modelOptions = modelResponse?.models?.length
    ? modelResponse.models
    : FALLBACK_MODELS;
  const defaultModel = modelResponse?.defaultModel ?? FALLBACK_DEFAULT_MODEL;

  const activeProject = useMemo(
    () =>
      projects.find((project) => project.project_id === activeProjectId) ??
      null,
    [projects, activeProjectId],
  );

  const projectMeta = useMemo(
    () => normalizeProjectMeta(activeProject?.meta ?? null),
    [activeProject?.meta],
  );

  const selectedModel = useMemo(() => {
    const rawModel = projectMeta["llmModel"];
    const candidate = typeof rawModel === "string" ? rawModel : undefined;
    if (candidate && modelOptions.some((option) => option.id === candidate)) {
      return candidate;
    }
    return defaultModel;
  }, [projectMeta, modelOptions, defaultModel]);

  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const selectModel = useCallback(
    async (modelId: string) => {
      if (!token || !activeProjectId) {
        setErrorMessage("프로젝트를 먼저 선택해 주세요.");
        setStatus("error");
        return;
      }
      if (!modelOptions.some((option) => option.id === modelId)) {
        setErrorMessage("지원되지 않는 모델입니다.");
        setStatus("error");
        return;
      }
      if (modelId === selectedModel) return;

      setStatus("saving");
      setErrorMessage(null);
      try {
        const nextMeta = { ...projectMeta, llmModel: modelId };
        await api.updateProject(token, activeProjectId, { meta: nextMeta });
        updateProjectMeta(activeProjectId, nextMeta);
        queryClient.invalidateQueries({ queryKey: projectKeys.list });
        queryClient.invalidateQueries({
          queryKey: projectKeys.content(activeProjectId),
        });
        setStatus("idle");
      } catch (error) {
        console.error("[modelSelection] Failed to update model", error);
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "모델을 변경하지 못했습니다. 다시 시도해 주세요.",
        );
        setStatus("error");
      }
    },
    [
      token,
      activeProjectId,
      modelOptions,
      selectedModel,
      projectMeta,
      updateProjectMeta,
      queryClient,
    ],
  );

  const selectedOption = useMemo(
    () =>
      modelOptions.find((option) => option.id === selectedModel) ??
      modelOptions[0],
    [modelOptions, selectedModel],
  );

  return {
    options: modelOptions,
    defaultModel,
    currentModel: selectedModel,
    selectedOption,
    selectModel,
    hasProject: Boolean(activeProjectId),
    isLoading: isModelsLoading,
    isSaving: status === "saving",
    isError,
    errorMessage,
  };
};
