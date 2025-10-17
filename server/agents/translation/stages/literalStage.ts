import type { SequentialStageResult, SequentialStageJob } from "../types";
import {
  LITERAL_SYSTEM_PROMPT,
  buildLiteralUserPrompt,
} from "../prompts/literal";
import { callStageLLM } from "../../../services/translation/llm";

export async function runLiteralStage(
  job: SequentialStageJob,
): Promise<SequentialStageResult[]> {
  const results = await Promise.all(
    job.segmentBatch.map(async (segment) => {
      const userPrompt = buildLiteralUserPrompt({ segment, config: job.config });
      const literalTemperature = Math.max(0, (job.config.temps.literal ?? 0.3) - 0.1);
      const callResult = await callStageLLM({
        stage: "literal",
        systemPrompt: LITERAL_SYSTEM_PROMPT,
        userPrompt,
        temperature: literalTemperature,
        maxOutputTokens: job.config.tokenBudget?.completionMax ?? 400,
      });

      const textTarget = callResult.text || segment.textSource;

      return {
        segmentId: segment.segmentId,
        stage: "literal",
        textTarget,
        baseline: segment.baseline,
        notes: {
          prompt: {
            system: LITERAL_SYSTEM_PROMPT,
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
