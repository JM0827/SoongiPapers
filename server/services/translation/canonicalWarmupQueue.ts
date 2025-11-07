import {
  Queue,
  QueueEvents,
  Worker,
  type Processor,
  type Job,
  type JobsOptions,
} from "bullmq";

import { createRedisClient, getSharedRedisClient } from "../redis";
import type { TranslationV2JobData } from "../translationV2Queue";

export interface CanonicalWarmupJobData
  extends Pick<
    TranslationV2JobData,
    | "projectId"
    | "jobId"
    | "originSegments"
    | "originDocumentId"
    | "originLanguage"
    | "targetLanguage"
  > {
  runId?: string | null;
}

const QUEUE_NAME = "translation_canonical_warmup";
const READY_TIMEOUT_MS = Number(process.env.QUEUE_READY_TIMEOUT_MS ?? 1500);

let warmupQueue: Queue<CanonicalWarmupJobData> | null = null;
let warmupQueueEvents: QueueEvents | null = null;
let warmupWorker: Worker<CanonicalWarmupJobData> | null = null;

function getWarmupQueue() {
  if (!warmupQueue) {
    const connection = getSharedRedisClient();
    warmupQueue = new Queue<CanonicalWarmupJobData>(QUEUE_NAME, { connection });
    warmupQueue.waitUntilReady().catch((error) => {
      console.error("[CANONICAL_WARMUP_QUEUE] init failed", error);
    });
  }
  if (!warmupQueueEvents) {
    const connection = getSharedRedisClient();
    warmupQueueEvents = new QueueEvents(QUEUE_NAME, { connection });
    warmupQueueEvents.waitUntilReady().catch((error) => {
      console.error("[CANONICAL_WARMUP_QUEUE_EVENTS] init failed", error);
    });
  }
  return { warmupQueue, warmupQueueEvents };
}

async function waitQueueReady(timeoutMs = READY_TIMEOUT_MS) {
  const { warmupQueue } = getWarmupQueue();
  await Promise.race([
    warmupQueue.waitUntilReady(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("canonical_queue_ready_timeout")), timeoutMs),
    ),
  ]);
}

export type CanonicalWarmupJob = Job<CanonicalWarmupJobData>;
export type CanonicalWarmupProcessor = Processor<CanonicalWarmupJobData>;

export function registerCanonicalWarmupProcessor(
  processor: CanonicalWarmupProcessor,
) {
  if (warmupWorker) {
    return warmupWorker;
  }
  warmupWorker = new Worker<CanonicalWarmupJobData>(QUEUE_NAME, processor, {
    connection: createRedisClient("canonical-warmup-worker"),
    concurrency: Number(process.env.CANONICAL_WARMUP_CONCURRENCY ?? 1),
  });

  warmupWorker.on("failed", (job, err) => {
    console.error("[CANONICAL_WARMUP_WORKER] fail", job?.id, err);
  });
  warmupWorker.on("completed", (job) => {
    console.log("[CANONICAL_WARMUP_WORKER] done", job?.id);
  });

  return warmupWorker;
}

export async function enqueueCanonicalWarmupJob(
  data: CanonicalWarmupJobData,
  options?: JobsOptions,
) {
  const { warmupQueue } = getWarmupQueue();
  await waitQueueReady();

  const dedupeJobId =
    options?.jobId ?? `canonical-warmup:${data.runId ?? data.jobId}`;

  const mergedOptions: JobsOptions = {
    attempts: 1,
    removeOnComplete: { age: 3600, count: 100 },
    removeOnFail: { age: 86400, count: 100 },
    jobId: dedupeJobId,
    ...options,
  };

  return warmupQueue.add("canonicalWarmup", data, mergedOptions);
}
