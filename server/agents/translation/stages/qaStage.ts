import type {
  ProjectMemory,
  SequentialStageResult,
  SequentialStageJob,
} from "../types";
import {
  QA_SYSTEM_PROMPT,
  buildQaUserPrompt,
} from "../prompts/qa";
import { callStageLLM } from "../../../services/translation/llm";

type QaSegmentLike = {
  stageOutputs?: {
    literal?: SequentialStageResult | null;
    style?: SequentialStageResult | null;
    emotion?: SequentialStageResult | null;
  } | null;
  textSource: string;
};

export function resolveQaTextTarget(
  segment: QaSegmentLike,
  emotionResult?: SequentialStageResult,
): string {
  if (emotionResult?.textTarget) return emotionResult.textTarget;
  if (segment.stageOutputs?.emotion?.textTarget)
    return segment.stageOutputs.emotion.textTarget;
  if (segment.stageOutputs?.style?.textTarget)
    return segment.stageOutputs.style.textTarget;
  if (segment.stageOutputs?.literal?.textTarget)
    return segment.stageOutputs.literal.textTarget;
  return "";
}

export async function runQaStage(
  job: SequentialStageJob,
  prior: SequentialStageResult[],
  memory: ProjectMemory | null,
): Promise<SequentialStageResult[]> {
  const priorById = new Map(prior.map((result) => [result.segmentId, result]));

  const results = await Promise.all(
    job.segmentBatch.map(async (segment) => {
      const emotionResult = priorById.get(segment.segmentId);
      const userPrompt = buildQaUserPrompt({
        segment,
        emotionResult,
        config: job.config,
        memory,
      });

      const callResult = await callStageLLM({
        stage: "qa",
        systemPrompt: QA_SYSTEM_PROMPT,
        userPrompt,
        temperature: 0,
        maxOutputTokens: Math.min(job.config.tokenBudget?.completionMax ?? 400, 600),
        responseFormat: { type: "json_object" },
      });

      let backTranslation = "";
      let issues: string[] = [];
      try {
        const parsed = JSON.parse(callResult.text || "{}") as {
          backTranslation?: string;
          issues?: string[];
        };
        if (typeof parsed.backTranslation === "string") {
          backTranslation = parsed.backTranslation.trim();
        }
        if (Array.isArray(parsed.issues)) {
          issues = parsed.issues
            .filter((issue): issue is string => typeof issue === "string")
            .map((issue) => issue.trim())
            .filter(Boolean);
        }
      } catch (error) {
        issues = [
          "QA output was not valid JSON; please review manually.",
          (error as Error).message ?? String(error),
        ];
      }

      const textTarget = resolveQaTextTarget(segment, emotionResult);

      return {
        segmentId: segment.segmentId,
        stage: "qa",
        textTarget,
        baseline: emotionResult?.baseline ?? segment.baseline,
        guards: emotionResult?.guards,
        notes: {
          prompt: {
            system: QA_SYSTEM_PROMPT,
            user: userPrompt,
          },
          model: callResult.model,
          usage: callResult.usage,
          backTranslation,
          issues,
        },
      } satisfies SequentialStageResult;
    }),
  );

  return results;
}
