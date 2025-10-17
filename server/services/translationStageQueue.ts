import { Queue, Worker, type Job, type JobsOptions, type Processor } from "bullmq";

import type { SequentialStageJob } from "../agents/translation";
import {
  getTranslationConcurrency,
  getTranslationStageQueueConfig,
} from "../config/appControlConfiguration";
import { createRedisClient } from "./redis";

const QUEUE_NAME = "translation_stage";

const stageQueue = new Queue<SequentialStageJob>(QUEUE_NAME, {
  connection: createRedisClient("translation-stage-queue"),
});

stageQueue.waitUntilReady().catch((error: unknown) => {
  console.error("[TRANSLATION QUEUE] Failed to initialize stage queue", error);
});

let stageWorker: Worker<SequentialStageJob, unknown, string> | null = null;

type StageProcessor = Processor<SequentialStageJob, unknown, string>;

export function registerTranslationStageProcessor(processor: StageProcessor) {
  if (stageWorker) {
    return stageWorker;
  }
  stageWorker = new Worker<SequentialStageJob>(QUEUE_NAME, processor, {
    connection: createRedisClient("translation-stage-worker"),
    concurrency: getTranslationConcurrency(),
  });
  return stageWorker;
}

const stageQueueConfig = getTranslationStageQueueConfig();

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  removeOnComplete: stageQueueConfig.removeOnComplete,
  ...(stageQueueConfig.removeOnFailAgeSeconds != null
    ? {
        removeOnFail: {
          age: stageQueueConfig.removeOnFailAgeSeconds,
        },
      }
    : {}),
};

export async function enqueueTranslationStageJob(
  data: SequentialStageJob,
  options?: JobsOptions,
) {
  const jobOptions = options
    ? {
        ...DEFAULT_JOB_OPTIONS,
        ...options,
      }
    : DEFAULT_JOB_OPTIONS;
  return stageQueue.add(`stage-${data.stage}`, data, jobOptions);
}

export async function pauseTranslationStageQueue() {
  await stageQueue.pause();
}

export async function closeTranslationStageQueue() {
  await Promise.all([stageWorker?.close(), stageQueue.close()]);
}

export type TranslationStageJob = Job<SequentialStageJob>;

export async function removeStageJobsFor(jobId: string) {
  const jobs = await stageQueue.getJobs(["waiting", "paused", "delayed", "active"]);
  await Promise.all(
    jobs
      .filter((job) => job.data?.jobId === jobId)
      .map((job) => job.remove().catch(() => undefined)),
  );
}
