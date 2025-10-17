import type {
  SequentialStageResult,
  TranslationStage,
} from "./types";
import type { TranslationStageJob } from "../../services/translationStageQueue";
import { runLiteralStage } from "./stages/literalStage";
import { runStyleStage } from "./stages/styleStage";
import { runEmotionStage } from "./stages/emotionStage";
import { runQaStage } from "./stages/qaStage";
import { ensureBaseline } from "../../services/translation/baselines";
import { evaluateGuards } from "../../services/translation/guards";
import { persistStageResults } from "../../services/translation/translationDraftStore";
import { enqueueTranslationStageJob } from "../../services/translationStageQueue";
import { fetchProjectMemory } from "../../services/translation/memory";
import { finalizeSequentialJob } from "../../services/translation/sequentialFinalizer";
import { completeAction } from "../../services/workflowManager";

type StageWorkerOverrides = Partial<{
  runLiteralStage: typeof runLiteralStage;
  runStyleStage: typeof runStyleStage;
  runEmotionStage: typeof runEmotionStage;
  runQaStage: typeof runQaStage;
  ensureBaseline: typeof ensureBaseline;
  evaluateGuards: typeof evaluateGuards;
  persistStageResults: typeof persistStageResults;
  enqueueTranslationStageJob: typeof enqueueTranslationStageJob;
  fetchProjectMemory: typeof fetchProjectMemory;
  finalizeSequentialJob: typeof finalizeSequentialJob;
  completeAction: typeof completeAction;
}>;

const getOverride = <K extends keyof StageWorkerOverrides>(
  key: K,
  fallback: NonNullable<StageWorkerOverrides[K]>,
) => {
  const overrides =
    ((globalThis as unknown as { __STAGE_WORKER_MOCKS?: StageWorkerOverrides })
      .__STAGE_WORKER_MOCKS ?? {}) as StageWorkerOverrides;
  return (overrides[key] ?? fallback) as NonNullable<StageWorkerOverrides[K]>;
};

const STAGE_SEQUENCE: TranslationStage[] = [
  "literal",
  "style",
  "emotion",
  "qa",
];

export async function handleTranslationStageJob(job: TranslationStageJob) {
  const { data } = job;
  const currentStageIndex = STAGE_SEQUENCE.indexOf(data.stage);
  if (currentStageIndex === -1) {
    throw new Error(`Unsupported stage: ${data.stage}`);
  }

  const ensureBaselineImpl = getOverride("ensureBaseline", ensureBaseline);
  const runLiteralStageImpl = getOverride("runLiteralStage", runLiteralStage);
  const runStyleStageImpl = getOverride("runStyleStage", runStyleStage);
  const runEmotionStageImpl = getOverride("runEmotionStage", runEmotionStage);
  const runQaStageImpl = getOverride("runQaStage", runQaStage);
  const evaluateGuardsImpl = getOverride("evaluateGuards", evaluateGuards);
  const persistStageResultsImpl = getOverride(
    "persistStageResults",
    persistStageResults,
  );
  const enqueueTranslationStageJobImpl = getOverride(
    "enqueueTranslationStageJob",
    enqueueTranslationStageJob,
  );
  const fetchProjectMemoryImpl = getOverride(
    "fetchProjectMemory",
    fetchProjectMemory,
  );
  const finalizeSequentialJobImpl = getOverride(
    "finalizeSequentialJob",
    finalizeSequentialJob,
  );
  const completeActionImpl = getOverride("completeAction", completeAction);

  if (data.stage === "literal") {
    await Promise.all(
      data.segmentBatch.map(async (segment) => {
        if (!segment.baseline) {
          const baseline = await ensureBaselineImpl(segment.textSource);
          if (baseline) {
            segment.baseline = baseline;
          }
        }
      }),
    );
  }

  const priorStageKey = currentStageIndex > 0 ? STAGE_SEQUENCE[currentStageIndex - 1] : null;
  const priorResults: SequentialStageResult[] = priorStageKey
    ? data.segmentBatch.map((segment) => {
        const prior = segment.stageOutputs?.[priorStageKey];
        if (prior) {
          return prior;
        }
        return {
          segmentId: segment.segmentId,
          stage: priorStageKey,
          textTarget: segment.stageOutputs?.literal?.textTarget ?? segment.textSource,
        };
      })
    : [];

  const memory = await fetchProjectMemoryImpl(data.projectId, data.memoryVersion);

  let stageResults: SequentialStageResult[] = [];

  switch (data.stage) {
    case "literal": {
      stageResults = await runLiteralStageImpl(data);
      break;
    }
    case "style": {
      stageResults = await runStyleStageImpl(data, priorResults, memory);
      break;
    }
    case "emotion": {
      stageResults = await runEmotionStageImpl(data, priorResults, memory);
      break;
    }
    case "qa": {
      stageResults = await runQaStageImpl(data, priorResults, memory);
      stageResults = await evaluateGuardsImpl(
        {
          direction:
            data.config.sourceLang === "ko" && data.config.targetLang === "en"
              ? "ko→en"
              : "en→ko",
          memory,
        },
        stageResults,
        data.segmentBatch,
      );
      break;
    }
    default: {
      throw new Error(`Unsupported stage: ${data.stage}`);
    }
  }

  await persistStageResultsImpl(data, stageResults);

  const updatedSegmentBatch = data.segmentBatch.map((segment, index) => {
    const nextOutputs = {
      ...(segment.stageOutputs ?? {}),
      [data.stage]: stageResults[index],
    };
    return {
      ...segment,
      stageOutputs: nextOutputs,
      baseline: nextOutputs.literal?.baseline ?? segment.baseline,
    };
  });

  if (data.stage === "qa") {
    const failingSegments = stageResults.filter(
      (result) => result.guards && result.guards.allOk === false,
    );

    if (failingSegments.length) {
      const attempt = data.retryContext?.attempt ?? 0;

      if (attempt === 0) {
        const downgradedConfig = {
          ...data.config,
          creativeAutonomy: "none" as const,
        };

        const downgradedBatch = updatedSegmentBatch.map((segment) => ({
          ...segment,
          stageOutputs: {
            literal: segment.stageOutputs?.literal,
          },
        }));

        await enqueueTranslationStageJobImpl({
          ...data,
          stage: "style",
          config: downgradedConfig,
          segmentBatch: downgradedBatch,
          retryContext: {
            attempt: attempt + 1,
            reason: "guard-fail-style",
          },
        });

        return {
          stage: data.stage,
          results: stageResults,
        };
      }

      if (attempt === 1) {
        const strictTemps = {
          ...data.config.temps,
          literal: Math.max(0.1, (data.config.temps.literal ?? 0.35) - 0.15),
        };

        const strictConfig = {
          ...data.config,
          creativeAutonomy: "none" as const,
          temps: strictTemps,
        };

        const literalResetBatch = data.segmentBatch.map((segment) => ({
          ...segment,
          stageOutputs: {},
        }));

        await enqueueTranslationStageJobImpl({
          ...data,
          stage: "literal",
          config: strictConfig,
          segmentBatch: literalResetBatch,
          retryContext: {
            attempt: attempt + 1,
            reason: "guard-fail-literal",
          },
        });

        return {
          stage: data.stage,
          results: stageResults,
        };
      }
      // attempt >= 2 → fall through and surface needs_review without further retries.
    }
  }

  const nextStage = STAGE_SEQUENCE[currentStageIndex + 1] ?? null;
  if (nextStage) {
    await enqueueTranslationStageJobImpl({
      ...data,
      stage: nextStage,
      segmentBatch: updatedSegmentBatch,
    });
  } else if (data.stage === "qa") {
    const finalization = await finalizeSequentialJobImpl({
      ...data,
      segmentBatch: updatedSegmentBatch,
    });

    if (finalization.finalized && finalization.completedNow && data.workflowRunId) {
      try {
        await completeActionImpl(data.workflowRunId, {
          jobId: data.jobId,
          translationFileId: finalization.translationFileId ?? null,
        });
      } catch (error) {
        console.warn(
          "[TRANSLATION] Failed to mark workflow run complete after sequential finalization",
          { error, jobId: data.jobId, workflowRunId: data.workflowRunId },
        );
      }
    }

    if (finalization.finalized && finalization.completedNow) {
      console.info?.(
        "[TRANSLATION] Sequential translation finalized",
        {
          jobId: data.jobId,
          projectId: data.projectId,
          translationFileId: finalization.translationFileId,
          needsReviewCount: finalization.needsReviewCount,
        },
      );
    }
  }

  return {
    stage: data.stage,
    results: stageResults,
  };
}
