import OpenAI from "openai";
import type {
  ResponseReasoningEffort,
  ResponseVerbosity,
  TranslationStage,
} from "../../agents/translation";
import { safeExtractOpenAIResponse } from "../llm";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY ?? "",
});

if (!process.env.OPENAI_API_KEY) {
  // eslint-disable-next-line no-console
  console.warn("[TRANSLATION] OPENAI_API_KEY is not set. Stage calls will fail.");
}

const DEFAULT_STAGE_MODELS: Record<TranslationStage, string> = {
  literal: process.env.SEQUENTIAL_LITERAL_MODEL ?? "gpt-5",
  style: process.env.SEQUENTIAL_STYLE_MODEL ?? "gpt-5",
  emotion: process.env.SEQUENTIAL_EMOTION_MODEL ?? "gpt-5",
  qa: process.env.SEQUENTIAL_QA_MODEL ?? "gpt-5-mini",
  draft:
    process.env.SEQUENTIAL_DRAFT_MODEL ??
    process.env.SEQUENTIAL_LITERAL_MODEL ??
    "gpt-5",
  revise:
    process.env.SEQUENTIAL_REVISE_MODEL ??
    process.env.SEQUENTIAL_STYLE_MODEL ??
    "gpt-5",
  "micro-check":
    process.env.SEQUENTIAL_MICRO_CHECK_MODEL ??
    process.env.SEQUENTIAL_QA_MODEL ??
    "gpt-5-mini",
};

export interface StageCallOptions {
  stage: TranslationStage;
  systemPrompt: string;
  userPrompt: string;
  verbosity: ResponseVerbosity;
  reasoningEffort: ResponseReasoningEffort;
  maxOutputTokens: number;
  responseFormat?: {
    type: "json_object";
  };
}

export interface StageCallResult {
  text: string;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export async function callStageLLM(options: StageCallOptions): Promise<StageCallResult> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is required to execute sequential translation stages",
    );
  }

  const model = DEFAULT_STAGE_MODELS[options.stage];
  const responseFormat = options.responseFormat
    ? { type: "json_object" as const }
    : undefined;

  const textConfig: {
    verbosity: ResponseVerbosity;
    format?: { type: "json_object" };
  } = {
    verbosity: options.verbosity,
  };

  if (responseFormat) {
    textConfig.format = responseFormat;
  }

  const response = await client.responses.create({
    model,
    max_output_tokens: options.maxOutputTokens,
    text: textConfig,
    reasoning: { effort: options.reasoningEffort },
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: options.systemPrompt }],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: options.userPrompt }],
      },
    ],
  });

  const { parsedJson, text, usage } = safeExtractOpenAIResponse(response);
  const resolvedText =
    (responseFormat && parsedJson
      ? JSON.stringify(parsedJson)
      : text?.trim()) ?? "";
  return {
    text: resolvedText,
    model: response.model ?? model,
    usage: {
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      totalTokens: usage?.total_tokens ?? 0,
    },
  };
}
