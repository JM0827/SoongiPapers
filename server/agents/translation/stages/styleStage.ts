import type {
  ProjectMemory,
  SequentialStageResult,
  SequentialStageJob,
} from "../types";
import {
  STYLE_SYSTEM_PROMPT,
  buildStyleUserPrompt,
} from "../prompts/style";
import { callStageLLM } from "../../../services/translation/llm";

export async function runStyleStage(
  job: SequentialStageJob,
  prior: SequentialStageResult[],
  memory: ProjectMemory | null,
): Promise<SequentialStageResult[]> {
  const priorById = new Map(prior.map((result) => [result.segmentId, result]));

  const results = await Promise.all(
    job.segmentBatch.map(async (segment) => {
      const literalResult = priorById.get(segment.segmentId);
      const userPrompt = buildStyleUserPrompt({
        segment,
        literalResult,
        config: job.config,
        memory,
      });

      const callResult = await callStageLLM({
        stage: "style",
        systemPrompt: STYLE_SYSTEM_PROMPT,
        userPrompt,
        temperature: job.config.temps.style ?? 0.6,
        maxOutputTokens: job.config.tokenBudget?.completionMax ?? 400,
      });

      const textTarget = callResult.text || literalResult?.textTarget || segment.textSource;

      return {
        segmentId: segment.segmentId,
        stage: "style",
        textTarget,
        baseline: literalResult?.baseline ?? segment.baseline,
        notes: {
          prompt: {
            system: STYLE_SYSTEM_PROMPT,
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
