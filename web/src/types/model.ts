export interface ModelOption {
  id: string;
  label: string;
  provider: "openai" | "anthropic" | "google" | "custom";
  description?: string;
  latencyClass?: "fast" | "balanced" | "quality";
  contextWindow?: number;
  capabilityTags?: string[];
  availability?: "general" | "preview" | "beta";
  recommended?: boolean;
}

export interface ModelListResponse {
  models: ModelOption[];
  defaultModel: string;
}
