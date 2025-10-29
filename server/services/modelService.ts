import type { FastifyBaseLogger } from "fastify";

export interface ChatModelOption {
  id: string;
  label: string;
  provider: "openai" | "anthropic" | "google" | "custom";
  description?: string;
  latencyClass: "fast" | "balanced" | "quality";
  contextWindow?: number;
  recommended?: boolean;
  capabilityTags?: string[];
  availability?: "general" | "preview" | "beta";
}

const BASE_MODELS: ChatModelOption[] = [
  {
    id: "gpt-5",
    label: "GPT-5",
    provider: "openai",
    description:
      "Next-gen reasoning model optimized for literary evaluation and revision.",
    latencyClass: "quality",
    contextWindow: 200_000,
    recommended: true,
    capabilityTags: ["general", "reasoning", "creative"],
  },
  {
    id: "gpt-4o-mini",
    label: "GPT-4o mini",
    provider: "openai",
    description:
      "Balanced quality and speed for everyday drafting and coordination.",
    latencyClass: "balanced",
    contextWindow: 128_000,
    recommended: false,
    capabilityTags: ["general", "fast"],
  },
  {
    id: "gpt-4o",
    label: "GPT-4o",
    provider: "openai",
    description:
      "Highest quality OpenAI general model for nuanced literary work.",
    latencyClass: "quality",
    contextWindow: 128_000,
    recommended: false,
    capabilityTags: ["general", "creative"],
  },
];

const normalizeModelId = (value: string | undefined | null) => value?.trim();

const envDefaultModel = normalizeModelId(process.env.CHAT_MODEL);

const defaultOption =
  envDefaultModel && BASE_MODELS.some((option) => option.id === envDefaultModel)
    ? envDefaultModel
    : (BASE_MODELS.find((option) => option.recommended)?.id ??
      BASE_MODELS[0]?.id ??
      "gpt-4o");

export const DEFAULT_CHAT_MODEL = defaultOption;

export const listChatModels = (): ChatModelOption[] => BASE_MODELS;

export const resolveChatModel = (
  requested?: string | null,
  logger?: FastifyBaseLogger,
): string => {
  if (!requested) return DEFAULT_CHAT_MODEL;
  const normalized = normalizeModelId(requested);
  if (!normalized) return DEFAULT_CHAT_MODEL;
  const isSupported = BASE_MODELS.some((option) => option.id === normalized);
  if (!isSupported) {
    logger?.warn(
      { requestedModel: requested },
      "[MODEL] Unsupported model requested, falling back to default",
    );
    return DEFAULT_CHAT_MODEL;
  }
  return normalized;
};

export const findChatModel = (
  modelId: string | null | undefined,
): ChatModelOption | undefined => {
  if (!modelId) return undefined;
  return BASE_MODELS.find((option) => option.id === modelId);
};
