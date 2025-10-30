import type { OpenAI } from "openai";

export type ResponsesRetryConfig<TResponse> = {
  client: OpenAI;
  /**
   * Called for each attempt. Should return the OpenAI Responses API payload.
   */
  buildRequest: (options: {
    maxOutputTokens: number;
    attemptIndex: number;
  }) => Promise<TResponse>;
  initialMaxOutputTokens: number;
  maxOutputTokensCap: number;
  maxAttempts?: number;
  minOutputTokens?: number;
  onAttempt?: (options: {
    attemptIndex: number;
    maxOutputTokens: number;
  }) => void;
};

export type ResponsesRetryResult<TResponse> = {
  response: TResponse;
  attempts: number;
  maxOutputTokens: number;
  truncated: boolean;
};

const DEFAULT_ATTEMPTS = 3;
const MIN_TOKENS_FALLBACK = 200;

export async function runResponsesWithRetry<TResponse>(
  config: ResponsesRetryConfig<TResponse>,
): Promise<ResponsesRetryResult<TResponse>> {
  const {
    buildRequest,
    initialMaxOutputTokens,
    maxOutputTokensCap,
    maxAttempts = DEFAULT_ATTEMPTS,
    minOutputTokens = MIN_TOKENS_FALLBACK,
    onAttempt,
  } = config;

  let maxTokens = Math.max(minOutputTokens, initialMaxOutputTokens);
  let truncatedEncountered = false;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < Math.max(1, maxAttempts); attempt += 1) {
    const currentTokens = Math.min(maxTokens, maxOutputTokensCap);
    onAttempt?.({ attemptIndex: attempt, maxOutputTokens: currentTokens });

    try {
      const response = await buildRequest({
        maxOutputTokens: currentTokens,
        attemptIndex: attempt,
      });

      return {
        response,
        attempts: attempt + 1,
        maxOutputTokens: currentTokens,
        truncated: truncatedEncountered,
      } satisfies ResponsesRetryResult<TResponse>;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "error" in error &&
        typeof (error as any).error === "object"
      ) {
        const inner = (error as any).error;
        if (inner?.type === "invalid_request_error") {
          throw error;
        }
      }
      lastError = error;
      if (isResponsesIncompleteError(error)) {
        truncatedEncountered = true;
        maxTokens = Math.min(Math.ceil(currentTokens * 1.5), maxOutputTokensCap);
        continue;
      }
      if (error instanceof SyntaxError) {
        maxTokens = Math.min(Math.ceil(currentTokens * 1.3), maxOutputTokensCap);
        continue;
      }
      throw error;
    }
  }

  if (lastError) throw lastError;
  throw new Error("OpenAI Responses call failed after retries");
}

export const RESPONSES_INCOMPLETE_ERROR_CODE = "openai_response_incomplete";

export function isResponsesIncompleteError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      (error as { code?: string }).code === RESPONSES_INCOMPLETE_ERROR_CODE,
  );
}
