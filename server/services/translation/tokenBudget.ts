import { z } from "zod";

interface BudgetSegmentLike {
  tokenEstimate?: number | null;
  text?: string | null;
}

export type TokenBudgetMode =
  | "draft"
  | "revise"
  | "micro-check"
  | "other";

export interface CalculateTokenBudgetParams {
  originSegments: BudgetSegmentLike[];
  mode: TokenBudgetMode;
  direction?: string | null;
  isDeepRevise?: boolean;
  defaultEstimate?: number | null;
}

export interface TokenBudgetResult {
  tokensInCap: number;
  intendedTokensOut: number;
  sourceTokenEstimate: number;
}

const DEFAULT_MIN_CAP = 120;
const DEFAULT_MAX_CAP = 800;
const DEFAULT_MULTIPLIER = 1.6;

const STAGE_MULTIPLIER: Record<TokenBudgetMode, number> = {
  draft: 1.6,
  revise: 1.1,
  "micro-check": 0.5,
  other: 1,
};

const MICROCHECK_MIN_DEFAULT = 80;
const MICROCHECK_MAX_DEFAULT = 120;

const REVISION_DEEP_MAX_CAP = z
  .preprocess(
    (value) => (typeof value === "string" ? Number(value) : value),
    z.number().int().positive().safe().catch(DEFAULT_MAX_CAP * 2),
  )
  .parse(process.env.REVISION_DEEP_MAX_CAP ?? DEFAULT_MAX_CAP * 1.5);

const MICROCHECK_MIN_CAP = z
  .preprocess(
    (value) => (typeof value === "string" ? Number(value) : value),
    z
      .number()
      .int()
      .positive()
      .catch(MICROCHECK_MIN_DEFAULT),
  )
  .parse(process.env.MICROCHECK_TOKENS_MIN ?? MICROCHECK_MIN_DEFAULT);

const MICROCHECK_MAX_CAP = z
  .preprocess(
    (value) => (typeof value === "string" ? Number(value) : value),
    z
      .number()
      .int()
      .positive()
      .catch(MICROCHECK_MAX_DEFAULT),
  )
  .parse(process.env.MICROCHECK_TOKENS_MAX ?? MICROCHECK_MAX_DEFAULT);

const POSITIVE_NUMBER_SCHEMA = z
  .number()
  .finite()
  .nonnegative()
  .catch(0);

const clamp = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) {
    return min;
  }
  if (min > max) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
};

const directionMultiplier = (direction?: string | null): number => {
  if (!direction) return 1;
  const normalized = direction.toLowerCase();
  if (normalized.includes("ko") && normalized.includes("en")) {
    const isKoToEn = normalized.startsWith("ko") || normalized.includes("ko->en");
    const isEnToKo = normalized.startsWith("en") || normalized.includes("en->ko");
    if (isKoToEn) return 1.2;
    if (isEnToKo) return 0.85;
  }
  return 1;
};

const computeSourceTokens = (
  segments: BudgetSegmentLike[],
  defaultEstimate?: number | null,
): number => {
  let total = 0;
  let fallbackChars = 0;

  segments.forEach((segment) => {
    const estimate = POSITIVE_NUMBER_SCHEMA.parse(segment.tokenEstimate ?? 0);
    if (estimate > 0) {
      total += estimate;
      return;
    }
    const text = typeof segment.text === "string" ? segment.text.trim() : "";
    if (text.length) {
      fallbackChars += text.length;
    }
  });

  if (fallbackChars > 0) {
    total += Math.ceil(fallbackChars / 4);
  }

  if (total <= 0 && defaultEstimate && Number.isFinite(defaultEstimate)) {
    total = Math.max(1, Math.ceil(defaultEstimate ?? 0));
  }

  return Math.max(1, Math.floor(total));
};

export function calculateTokenBudget(
  params: CalculateTokenBudgetParams,
): TokenBudgetResult {
  const {
    originSegments,
    mode,
    direction,
    isDeepRevise = false,
    defaultEstimate,
  } = params;

  if (!Array.isArray(originSegments) || originSegments.length === 0) {
    const fallback = clamp(DEFAULT_MIN_CAP, DEFAULT_MIN_CAP, DEFAULT_MAX_CAP);
    return {
      tokensInCap: fallback,
      intendedTokensOut: fallback,
      sourceTokenEstimate: DEFAULT_MIN_CAP,
    };
  }

  const sourceTokens = computeSourceTokens(originSegments, defaultEstimate);
  const multiplier = directionMultiplier(direction);
  const stageMultiplier = STAGE_MULTIPLIER[mode] ?? STAGE_MULTIPLIER.other;
  const capRaw = Math.ceil(
    sourceTokens * DEFAULT_MULTIPLIER * multiplier * stageMultiplier,
  );

  const isMicroCheck = mode === "micro-check";
  const minCap = isMicroCheck ? MICROCHECK_MIN_CAP : DEFAULT_MIN_CAP;
  const maxCap = isMicroCheck
    ? MICROCHECK_MAX_CAP
    : isDeepRevise
      ? Math.max(DEFAULT_MAX_CAP, REVISION_DEEP_MAX_CAP)
      : DEFAULT_MAX_CAP;

  let tokensInCap = clamp(capRaw, minCap, maxCap);

  if (!Number.isFinite(tokensInCap) || tokensInCap <= 0) {
    console.warn("[tokenBudget] Invalid tokensInCap computed", {
      sourceTokens,
      capRaw,
      mode,
      direction,
      isDeepRevise,
    });
    tokensInCap = clamp(DEFAULT_MIN_CAP, minCap, maxCap);
  }

  return {
    tokensInCap,
    intendedTokensOut: tokensInCap,
    sourceTokenEstimate: sourceTokens,
  };
}
