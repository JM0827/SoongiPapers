import { readFileSync } from "node:fs";
import path from "node:path";

import type {
  ContextPolicyConfig,
  LanguageCode,
  ResponseReasoningEffort,
  ResponseVerbosity,
  SegmentMode,
  SequentialStageLLMParameters,
  SequentialTranslationBatchingConfig,
  SequentialTranslationConfig,
  SequentialTranslationProofreadConfig,
  SequentialTranslationStageConfig,
  SequentialTranslationTokenBudget,
} from "@bookko/translation-types";

type StageParameterOverrides = Partial<
  Record<
    keyof SequentialTranslationStageConfig,
    Partial<SequentialStageLLMParameters>
  >
>;

type SequentialTranslationOverrides = Partial<
  Omit<
    SequentialTranslationConfig,
    "contextPolicy" | "stageParameters" | "batching" | "tokenBudget" | "proofread"
  >
> & {
  contextPolicy?: Partial<ContextPolicyConfig>;
  stageParameters?: StageParameterOverrides;
  batching?: Partial<SequentialTranslationBatchingConfig>;
  tokenBudget?: Partial<SequentialTranslationTokenBudget>;
  proofread?: Partial<SequentialTranslationProofreadConfig>;
};

interface AppControlConfiguration {
  lineJoiner?: boolean;
  translation?: SequentialTranslationOverrides;
}

const DEFAULT_SEGMENTATION_MODE: SegmentMode = "paragraph";

type SegmentationMode = SegmentMode;

function buildStageParams(
  verbosity: ResponseVerbosity,
  reasoningEffort: ResponseReasoningEffort,
  maxOutputTokens: number,
): SequentialStageLLMParameters {
  return {
    verbosity,
    reasoningEffort,
    maxOutputTokens,
  };
}

function mergeStageParameters(
  base: SequentialTranslationStageConfig,
  overrides?: StageParameterOverrides,
): SequentialTranslationStageConfig {
  const literal = {
    ...base.literal,
    ...(overrides?.literal ?? {}),
  } satisfies SequentialStageLLMParameters;
  const style = {
    ...base.style,
    ...(overrides?.style ?? {}),
  } satisfies SequentialStageLLMParameters;
  const emotion = {
    ...base.emotion,
    ...(overrides?.emotion ?? {}),
  } satisfies SequentialStageLLMParameters;
  const qa = {
    ...base.qa,
    ...(overrides?.qa ?? {}),
  } satisfies SequentialStageLLMParameters;

  return {
    literal,
    style,
    emotion,
    qa,
  };
}

const DEFAULT_STAGE_PARAMETERS: SequentialTranslationStageConfig = {
  literal: buildStageParams("low", "minimal", 900),
  style: buildStageParams("medium", "low", 900),
  emotion: buildStageParams("medium", "medium", 900),
  qa: buildStageParams("low", "low", 600),
};

const DEFAULT_TRANSLATION_CONFIG: SequentialTranslationConfig = {
  translationMode: "sequential",
  sourceLang: "ko",
  targetLang: "en",
  segmentMode: "paragraph",
  window: 1,
  contextPolicy: {
    verbatimMax: 300,
    summaryMax: 120,
    mode: "hybrid",
  },
  stageParameters: DEFAULT_STAGE_PARAMETERS,
  register: "literary",
  honorifics: "preserve",
  romanizationPolicy: "as-is",
  creativeAutonomy: "light",
  batching: {
    batchSize: 8,
    workerConcurrency: 2,
    apiRateLimitTPS: 2,
  },
  tokenBudget: {
    promptMax: 3000,
    completionMax: 900,
  },
  proofread: {
    topK: 7,
    minSeverity: "medium",
    autoApplySafeFixes: false,
  },
};

let cachedConfig: AppControlConfiguration | null = null;
let lastLoadAttempted = false;

const CONFIG_PATH =
  process.env.APP_CONTROL_CONFIG_PATH ??
  path.resolve(process.cwd(), "server", "appControlConfiguration.json");

function loadConfiguration(): AppControlConfiguration {
  if (cachedConfig) {
    return cachedConfig;
  }
  if (lastLoadAttempted && cachedConfig === null) {
    return {};
  }
  lastLoadAttempted = true;
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    cachedConfig = JSON.parse(raw) as AppControlConfiguration;
    return cachedConfig ?? {};
  } catch (error) {
    cachedConfig = {};
    return cachedConfig;
  }
}

function mergeTranslationConfig(
  overrides: AppControlConfiguration["translation"],
): SequentialTranslationConfig {
  if (!overrides) {
    return DEFAULT_TRANSLATION_CONFIG;
  }

  const resolveLang = (
    lang: LanguageCode | string | undefined,
    fallback: LanguageCode,
  ): LanguageCode => {
    if (!lang) {
      return fallback;
    }
    const lower = lang.toLowerCase() as LanguageCode;
    return (lower === "ko" || lower === "en") ? lower : fallback;
  };

  const segmentMode =
    overrides.segmentMode === "sentence"
      ? "sentence"
      : DEFAULT_TRANSLATION_CONFIG.segmentMode;

  const windowValue =
    typeof overrides.window === "number"
      ? overrides.window
      : DEFAULT_TRANSLATION_CONFIG.window;

  const contextOverrides = overrides.contextPolicy as
    | Partial<ContextPolicyConfig>
    | undefined;
  const stageParametersOverride = overrides.stageParameters as
    | StageParameterOverrides
    | undefined;
  const batchingOverride = overrides.batching as
    | Partial<SequentialTranslationBatchingConfig>
    | undefined;
  const tokenBudgetOverride = overrides.tokenBudget as
    | Partial<SequentialTranslationTokenBudget>
    | undefined;
  const proofreadOverride = overrides.proofread as
    | Partial<SequentialTranslationProofreadConfig>
    | undefined;

  const register =
    typeof overrides.register === "string"
      ? overrides.register
      : DEFAULT_TRANSLATION_CONFIG.register;

  const honorifics =
    typeof overrides.honorifics === "string"
      ? overrides.honorifics
      : DEFAULT_TRANSLATION_CONFIG.honorifics;

  const romanizationPolicy =
    typeof overrides.romanizationPolicy === "string"
      ? overrides.romanizationPolicy
      : DEFAULT_TRANSLATION_CONFIG.romanizationPolicy;

  const creativeAutonomyValues = new Set(["none", "light", "moderate"]);
  const creativeAutonomy =
    typeof overrides.creativeAutonomy === "string" &&
    creativeAutonomyValues.has(overrides.creativeAutonomy)
      ? (overrides.creativeAutonomy as "none" | "light" | "moderate")
      : DEFAULT_TRANSLATION_CONFIG.creativeAutonomy;

  return {
    translationMode: "sequential",
    sourceLang: resolveLang(
      typeof overrides.sourceLang === "string"
        ? overrides.sourceLang
        : undefined,
      DEFAULT_TRANSLATION_CONFIG.sourceLang,
    ),
    targetLang: resolveLang(
      typeof overrides.targetLang === "string"
        ? overrides.targetLang
        : undefined,
      DEFAULT_TRANSLATION_CONFIG.targetLang,
    ),
    segmentMode,
    window: windowValue,
    contextPolicy: {
      ...DEFAULT_TRANSLATION_CONFIG.contextPolicy,
      ...(contextOverrides ?? {}),
    },
    stageParameters: mergeStageParameters(
      DEFAULT_TRANSLATION_CONFIG.stageParameters,
      stageParametersOverride,
    ),
    register,
    honorifics,
    romanizationPolicy,
    creativeAutonomy,
    batching: {
      ...DEFAULT_TRANSLATION_CONFIG.batching,
      ...(batchingOverride ?? {}),
    },
    tokenBudget: {
      ...DEFAULT_TRANSLATION_CONFIG.tokenBudget,
      ...(tokenBudgetOverride ?? {}),
    },
    proofread: {
      ...DEFAULT_TRANSLATION_CONFIG.proofread,
      ...(proofreadOverride ?? {}),
    },
  };
}

export function reloadAppControlConfiguration(): void {
  cachedConfig = null;
  lastLoadAttempted = false;
}

export function isLineJoinerEnabled(): boolean {
  const config = loadConfiguration();
  return Boolean(config.lineJoiner);
}

export function getSequentialTranslationConfig(): SequentialTranslationConfig {
  const config = loadConfiguration();
  return mergeTranslationConfig(config.translation);
}

export function getTranslationSegmentationMode(): SegmentationMode {
  const config = getSequentialTranslationConfig();
  return config.segmentMode === "sentence" ? "sentence" : DEFAULT_SEGMENTATION_MODE;
}

export function getTranslationPassCount(): number {
  // Sequential pipeline only runs one pass per stage.
  return 1;
}

export function getTranslationConcurrency(): number {
  const config = getSequentialTranslationConfig();
  return Math.max(1, Math.floor(config.batching.workerConcurrency));
}

export type { SegmentationMode };
