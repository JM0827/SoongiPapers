export type ResponseVerbosity = "low" | "medium" | "high";
export type ResponseReasoningEffort = "minimal" | "low" | "medium" | "high";

const VERBOSITY_VALUES: ResponseVerbosity[] = ["low", "medium", "high"];
const REASONING_VALUES: ResponseReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
];

const DEFAULT_CHAT_MODEL = process.env.CHAT_MODEL?.trim() || "gpt-5";
const DEFAULT_CHAT_FALLBACK_MODEL =
  process.env.CHAT_FALLBACK_MODEL?.trim() || "gpt-5-mini";

const normalizeVerbosity = (
  value: string | undefined,
  fallback: ResponseVerbosity,
): ResponseVerbosity => {
  if (!value) return fallback;
  const lower = value.trim().toLowerCase();
  if (VERBOSITY_VALUES.includes(lower as ResponseVerbosity)) {
    return lower as ResponseVerbosity;
  }
  return fallback;
};

const normalizeEffort = (
  value: string | undefined,
  fallback: ResponseReasoningEffort,
): ResponseReasoningEffort => {
  if (!value) return fallback;
  const lower = value.trim().toLowerCase();
  if (REASONING_VALUES.includes(lower as ResponseReasoningEffort)) {
    return lower as ResponseReasoningEffort;
  }
  return fallback;
};

const parseInteger = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
};

export interface ChatResponsesDefaults {
  model: string;
  fallbackModel: string;
  verbosity: ResponseVerbosity;
  reasoningEffort: ResponseReasoningEffort;
  maxOutputTokens: number;
  maxOutputTokensCap: number;
}

export const getChatResponsesDefaults = (): ChatResponsesDefaults => {
  const maxTokens = parseInteger(process.env.CHAT_MAX_OUTPUT_TOKENS, 900);
  const maxTokensCap = Math.max(maxTokens, 1_600);

  return {
    model: DEFAULT_CHAT_MODEL,
    fallbackModel: DEFAULT_CHAT_FALLBACK_MODEL,
    verbosity: normalizeVerbosity(process.env.CHAT_VERBOSITY, "medium"),
    reasoningEffort: normalizeEffort(
      process.env.CHAT_REASONING_EFFORT,
      "medium",
    ),
    maxOutputTokens: maxTokens,
    maxOutputTokensCap: maxTokensCap,
  } satisfies ChatResponsesDefaults;
};

export interface IntentClassifierDefaults {
  model: string;
  verbosity: ResponseVerbosity;
  reasoningEffort: ResponseReasoningEffort;
  maxOutputTokens: number;
}

export const getIntentClassifierDefaults = (): IntentClassifierDefaults => ({
  model: process.env.INTENT_CLASSIFIER_MODEL?.trim() || "gpt-5-mini",
  verbosity: normalizeVerbosity(process.env.INTENT_CLASSIFIER_VERBOSITY, "low"),
  reasoningEffort: normalizeEffort(
    process.env.INTENT_CLASSIFIER_EFFORT,
    "minimal",
  ),
  maxOutputTokens: parseInteger(
    process.env.INTENT_CLASSIFIER_MAX_OUTPUT_TOKENS,
    256,
  ),
});

export interface EntityExtractionDefaults {
  model: string;
  verbosity: ResponseVerbosity;
  reasoningEffort: ResponseReasoningEffort;
  maxOutputTokens: number;
}

export const getEntityExtractionDefaults = (): EntityExtractionDefaults => ({
  model: process.env.CHAT_ENTITY_MODEL?.trim() || DEFAULT_CHAT_FALLBACK_MODEL,
  verbosity: normalizeVerbosity(process.env.CHAT_ENTITY_VERBOSITY, "low"),
  reasoningEffort: normalizeEffort(process.env.CHAT_ENTITY_EFFORT, "minimal"),
  maxOutputTokens: parseInteger(process.env.CHAT_ENTITY_MAX_OUTPUT_TOKENS, 256),
});

export interface EditingAssistantDefaults {
  model: string;
  verbosity: ResponseVerbosity;
  reasoningEffort: ResponseReasoningEffort;
  maxOutputTokens: number;
  maxOutputTokensCap: number;
}

export const getEditingAssistantDefaults = (
  baseTokens: number,
): EditingAssistantDefaults => {
  const envMaxTokens = parseInteger(
    process.env.EDITING_ASSIST_MAX_OUTPUT_TOKENS,
    baseTokens,
  );

  return {
    model:
      process.env.EDITING_ASSIST_MODEL?.trim() || DEFAULT_CHAT_FALLBACK_MODEL,
    verbosity: normalizeVerbosity(process.env.EDITING_ASSIST_VERBOSITY, "low"),
    reasoningEffort: normalizeEffort(
      process.env.EDITING_ASSIST_REASONING_EFFORT,
      "low",
    ),
    maxOutputTokens: envMaxTokens,
    maxOutputTokensCap: Math.max(envMaxTokens, baseTokens * 3),
  } satisfies EditingAssistantDefaults;
};
