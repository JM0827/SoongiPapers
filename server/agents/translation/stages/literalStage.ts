import type { SequentialStageResult, SequentialStageJob } from "../types";
import {
  LITERAL_SYSTEM_PROMPT,
  buildLiteralUserPrompt,
} from "../prompts/literal";
import { callStageLLM } from "../../../services/translation/llm";

function resolveMaxTokens(job: SequentialStageJob, proposed: number): number {
  const budget = job.config.tokenBudget?.completionMax;
  if (typeof budget === "number" && budget > 0) {
    return Math.min(proposed, budget);
  }
  return proposed;
}

export async function runLiteralStage(
  job: SequentialStageJob,
): Promise<SequentialStageResult[]> {
  const results = await Promise.all(
    job.segmentBatch.map(async (segment) => {
      const userPrompt = buildLiteralUserPrompt({ segment, config: job.config });
      const stageParams =
        job.config.stageParameters?.literal ?? {
          verbosity: "low",
          reasoningEffort: "minimal",
          maxOutputTokens: job.config.tokenBudget?.completionMax ?? 900,
        };
      const callResult = await callStageLLM({
        stage: "literal",
        systemPrompt: LITERAL_SYSTEM_PROMPT,
        userPrompt,
        verbosity: stageParams.verbosity,
        reasoningEffort: stageParams.reasoningEffort,
        maxOutputTokens: resolveMaxTokens(job, stageParams.maxOutputTokens),
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
