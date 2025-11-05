import type { OpenAI } from "openai";

export type ResponsesRetryStage =
  | "primary"
  | "downshift"
  | "minimal"
  | "fallback"
  | "segment";

export type ResponsesRetryReason =
  | "initial"
  | "incomplete"
  | "json_parse"
  | "rate_limit"
  | "segment_retry";

export interface ResponsesRetryAttemptContext {
  attemptIndex: number;
  maxOutputTokens: number;
  stage: ResponsesRetryStage;
  reason: ResponsesRetryReason;
  usingFallback: boolean;
  usingSegmentRetry: boolean;
}

export type ResponsesRetryConfig<TResponse> = {
  client: OpenAI;
  /**
   * Called for each attempt. Should return the OpenAI Responses API payload.
   */
  buildRequest: (
    options: ResponsesRetryAttemptContext,
  ) => Promise<TResponse>;
  initialMaxOutputTokens: number;
  maxOutputTokensCap: number;
  maxAttempts?: number;
  minOutputTokens?: number;
  onAttempt?: (options: ResponsesRetryAttemptContext) => void;
  buildFallbackRequest?: (
    options: ResponsesRetryAttemptContext,
  ) => Promise<TResponse>;
  retrySegmentFn?: (
    options: ResponsesRetryAttemptContext,
  ) => Promise<TResponse | null>;
};

export type ResponsesRetryResult<TResponse> = {
  response: TResponse;
  attempts: number;
  maxOutputTokens: number;
  truncated: boolean;
  attemptHistory: ResponsesRetryAttemptContext[];
};

export const RESPONSES_INCOMPLETE_ERROR_CODE = "openai_response_incomplete";

const DEFAULT_ATTEMPTS = 3;
const MIN_TOKENS_FALLBACK = 200;

const RESPONSES_INCOMPLETE_REASON = "max_output_tokens";

const BASE_STAGE_SEQUENCE: Array<{
  stage: ResponsesRetryStage;
  multiplier: number;
  usingFallback: boolean;
  usingSegmentRetry: boolean;
}> = [
  { stage: "primary", multiplier: 1, usingFallback: false, usingSegmentRetry: false },
  { stage: "downshift", multiplier: 0.7, usingFallback: false, usingSegmentRetry: false },
  { stage: "minimal", multiplier: 0.49, usingFallback: false, usingSegmentRetry: false },
];

const isResponseIncomplete = (response: unknown): boolean => {
  if (!response || typeof response !== "object") return false;
  const record = response as {
    status?: string;
    incomplete_details?: { reason?: string };
  };
  if (record.status !== "incomplete") return false;
  const reason = record.incomplete_details?.reason;
  return !reason || reason === RESPONSES_INCOMPLETE_REASON;
};

const isRateLimitError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: number | string }).code;
  if (code === 429) return true;
  const status = (error as { status?: number }).status;
  if (status === 429) return true;
  const inner = (error as { error?: unknown }).error;
  if (inner && typeof inner === "object") {
    const innerStatus = (inner as { status?: number }).status;
    if (innerStatus === 429) return true;
    const innerType = (inner as { type?: string }).type;
    if (innerType === "rate_limit_error") return true;
    const message = (inner as { message?: string }).message;
    if (typeof message === "string" && message.toLowerCase().includes("rate limit")) {
      return true;
    }
  }
  return false;
};

const createIncompleteError = (
  response: {
    incomplete_details?: { reason?: string };
    id?: string | null;
  } | null,
): Error & {
  code?: string;
  metadata?: Record<string, unknown>;
} => {
  const err: Error & { code?: string; metadata?: Record<string, unknown> } =
    new Error("OpenAI response incomplete");
  err.code = RESPONSES_INCOMPLETE_ERROR_CODE;
  err.metadata = {
    reason:
      response?.incomplete_details?.reason ?? RESPONSES_INCOMPLETE_REASON,
    responseId: response?.id ?? null,
  };
  return err;
};

export async function runResponsesWithRetry<TResponse>(
  config: ResponsesRetryConfig<TResponse>,
): Promise<ResponsesRetryResult<TResponse>> {
  const {
    buildRequest,
    buildFallbackRequest,
    retrySegmentFn,
    initialMaxOutputTokens,
    maxOutputTokensCap,
    maxAttempts = DEFAULT_ATTEMPTS,
    minOutputTokens = MIN_TOKENS_FALLBACK,
    onAttempt,
  } = config;

  const stages: Array<{
    stage: ResponsesRetryStage;
    multiplier: number;
    usingFallback: boolean;
    usingSegmentRetry: boolean;
  }> = [...BASE_STAGE_SEQUENCE];

  if (buildFallbackRequest) {
    stages.push({
      stage: "fallback",
      multiplier: Math.max(BASE_STAGE_SEQUENCE[BASE_STAGE_SEQUENCE.length - 1].multiplier, 1),
      usingFallback: true,
      usingSegmentRetry: false,
    });
  }

  if (retrySegmentFn) {
    stages.push({
      stage: "segment",
      multiplier: 1,
      usingFallback: false,
      usingSegmentRetry: true,
    });
  }

  const baseTokens = Math.max(minOutputTokens, initialMaxOutputTokens);
  const attemptHistory: ResponsesRetryAttemptContext[] = [];

  let attempts = 0;
  let stageIndex = 0;
  let lastError: unknown = null;
  let lastReason: ResponsesRetryReason = "initial";
  let lastTokensUsed = Math.min(baseTokens, maxOutputTokensCap);
  let truncatedEncountered = false;

  while (
    attempts < Math.max(1, maxAttempts) &&
    stageIndex < stages.length
  ) {
    const stage = stages[stageIndex];
    const shouldDownshift =
      stage.multiplier < 1 && (lastReason === "incomplete" || truncatedEncountered);
    const effectiveMultiplier =
      stage.multiplier >= 1 || shouldDownshift ? stage.multiplier : 1;
    const computedTokens = Math.min(
      maxOutputTokensCap,
      Math.max(minOutputTokens, Math.ceil(baseTokens * effectiveMultiplier)),
    );

    const context: ResponsesRetryAttemptContext = {
      attemptIndex: attempts,
      maxOutputTokens: computedTokens,
      stage: stage.stage,
      reason: lastReason,
      usingFallback: stage.usingFallback,
      usingSegmentRetry: stage.usingSegmentRetry,
    };

    attemptHistory.push(context);
    onAttempt?.(context);

    try {
      let response: TResponse | null = null;

      if (stage.usingSegmentRetry) {
        response = (await retrySegmentFn?.(context)) ?? null;
        if (!response) {
          lastReason = "segment_retry";
          lastError = new Error("Segment retry handler returned no response");
          attempts += 1;
          stageIndex += 1;
          continue;
        }
      } else if (stage.usingFallback) {
        response = await buildFallbackRequest!(context);
      } else {
        response = await buildRequest(context);
      }

      attempts += 1;
      lastTokensUsed = context.maxOutputTokens;

      if (isResponseIncomplete(response)) {
        lastReason = "incomplete";
        truncatedEncountered = true;
        return {
          response,
          attempts,
          maxOutputTokens: lastTokensUsed,
          truncated: true,
          attemptHistory,
        } satisfies ResponsesRetryResult<TResponse>;
      }

      return {
        response,
        attempts,
        maxOutputTokens: lastTokensUsed,
        truncated: truncatedEncountered,
        attemptHistory,
      } satisfies ResponsesRetryResult<TResponse>;
    } catch (error) {
      attempts += 1;

      if (error && typeof error === "object" && "error" in error) {
        const inner = (error as { error?: unknown }).error;
      if (
        inner &&
        typeof inner === "object" &&
        (inner as { type?: string }).type === "invalid_request_error"
      ) {
        throw error;
      }
      }

      if (isResponsesIncompleteError(error)) {
        lastReason = "incomplete";
        lastError = error;
        truncatedEncountered = true;
        if (stageIndex < stages.length - 1) {
          stageIndex += 1;
          continue;
        }
        throw error;
      }

      if (error instanceof SyntaxError) {
        lastReason = "json_parse";
        lastError = error;
        if (stageIndex < stages.length - 1) {
          stageIndex += 1;
          continue;
        }
        throw error;
      }

      if (isRateLimitError(error)) {
        lastReason = "rate_limit";
        lastError = error;
        if (attempts < Math.max(1, maxAttempts)) {
          continue;
        }
        throw error;
      }

      lastError = error;
      throw error;
    }
  }

  if (lastError) throw lastError;
  throw new Error("OpenAI Responses call failed after retries");
}

export function isResponsesIncompleteError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      (error as { code?: string }).code === RESPONSES_INCOMPLETE_ERROR_CODE,
  );
}
