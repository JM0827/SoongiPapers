import type {
  ProjectMemory,
  SequentialStageResult,
  SequentialStageJob,
} from "../types";
import {
  EMOTION_SYSTEM_PROMPT,
  buildEmotionUserPrompt,
} from "../prompts/emotion";
import { callStageLLM } from "../../../services/translation/llm";

export async function runEmotionStage(
  job: SequentialStageJob,
  prior: SequentialStageResult[],
  memory: ProjectMemory | null,
): Promise<SequentialStageResult[]> {
  const priorById = new Map(prior.map((result) => [result.segmentId, result]));

  const results = await Promise.all(
    job.segmentBatch.map(async (segment) => {
      const styleResult = priorById.get(segment.segmentId);
      const userPrompt = buildEmotionUserPrompt({
        segment,
        styleResult,
        config: job.config,
        memory,
      });

      const callResult = await callStageLLM({
        stage: "emotion",
        systemPrompt: EMOTION_SYSTEM_PROMPT,
        userPrompt,
        temperature: job.config.temps.emotion ?? 0.6,
        maxOutputTokens: job.config.tokenBudget?.completionMax ?? 400,
      });

      const textTarget = callResult.text || styleResult?.textTarget || segment.textSource;

      return {
        segmentId: segment.segmentId,
        stage: "emotion",
        textTarget,
        baseline: styleResult?.baseline ?? segment.baseline,
        notes: {
          prompt: {
            system: EMOTION_SYSTEM_PROMPT,
            user: userPrompt,
          },
          model: callResult.model,
          usage: callResult.usage,
        },
      } satisfies SequentialStageResult;
    }),
  );

  return results;
}
