import type { OpenAI } from "openai";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";

import {
  runResponsesWithRetry,
  type ResponsesRetryAttemptContext,
} from "./openaiResponses";
import {
  type ResponseReasoningEffort,
  type ResponseVerbosity,
} from "./responsesConfig";
import { safeExtractOpenAIResponse } from "./llm";

export type ResponsesInputMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type JsonSchemaEnvelope = {
  name: string;
  schema: Record<string, unknown>;
};

export const toResponsesInput = (
  messages: ResponsesInputMessage[],
): ResponseCreateParamsNonStreaming["input"] =>
  messages.map((message) => ({
    role: message.role,
    content: [{ type: "input_text", text: message.content }],
  }));

export interface JsonSchemaResponseOptions<TParsed> {
  client: OpenAI;
  model: string;
  maxOutputTokens: number;
  maxOutputTokensCap: number;
  messages: ResponsesInputMessage[];
  schema: JsonSchemaEnvelope;
  verbosity: ResponseVerbosity;
  reasoningEffort: ResponseReasoningEffort;
  maxAttempts?: number;
  minOutputTokens?: number;
}

export interface JsonSchemaResponseResult<TParsed> {
  parsed: TParsed;
  rawText?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  responseId?: string;
  attempts: number;
  truncated: boolean;
  maxOutputTokens: number;
  attemptHistory: ResponsesRetryAttemptContext[];
}

export const runJsonSchemaResponse = async <TParsed>(
  options: JsonSchemaResponseOptions<TParsed>,
): Promise<JsonSchemaResponseResult<TParsed>> => {
  const {
    client,
    model,
    maxOutputTokens,
    maxOutputTokensCap,
    messages,
    schema,
    verbosity,
    reasoningEffort,
    maxAttempts,
    minOutputTokens,
  } = options;

  const runResult = await runResponsesWithRetry({
    client,
    initialMaxOutputTokens: maxOutputTokens,
    maxOutputTokensCap,
    maxAttempts,
    minOutputTokens,
    buildRequest: async ({ maxOutputTokens: requestTokens }) =>
      client.responses.create({
        model,
        max_output_tokens: requestTokens,
        text: {
          verbosity,
          format: {
            type: "json_schema",
            name: schema.name,
            schema: schema.schema,
            strict: true,
          },
        },
        reasoning: { effort: reasoningEffort },
        input: toResponsesInput(messages),
      }),
  });

  const extracted = safeExtractOpenAIResponse(runResult.response);
  if (!extracted.parsedJson) {
    throw new Error("OpenAI Responses payload missing parsed JSON");
  }

  return {
    parsed: extracted.parsedJson as TParsed,
    rawText: extracted.text,
    usage: extracted.usage,
    responseId: extracted.requestId,
    attempts: runResult.attempts,
    truncated: runResult.truncated,
    maxOutputTokens: runResult.maxOutputTokens,
    attemptHistory: runResult.attemptHistory,
  } satisfies JsonSchemaResponseResult<TParsed>;
};
