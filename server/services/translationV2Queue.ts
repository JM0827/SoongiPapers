import { Queue, Worker, type JobsOptions, type Processor, type Job } from "bullmq";
import { createRedisClient } from "./redis";
import type { OriginSegment } from "../agents/translation/segmentationAgent";
import type { SequentialTranslationStageConfig } from "../agents/translation";
import type { TranslationNotes } from "../models/DocumentProfile";

export interface TranslationV2JobData {
  projectId: string;
  jobId: string;
  workflowRunId?: string | null;
  sourceHash: string;
  originLanguage?: string | null;
  targetLanguage?: string | null;
  originSegments: OriginSegment[];
  translationNotes?: TranslationNotes | null;
  projectTitle?: string | null;
  authorName?: string | null;
  synopsis?: string | null;
  register?: string | null;
  candidateCount?: number;
  stageParameters?: SequentialTranslationStageConfig;
}

const V2_QUEUE_NAME = "translation_v2";

const v2Queue = new Queue<TranslationV2JobData>(V2_QUEUE_NAME, {
  connection: createRedisClient("translation-v2-queue"),
});

v2Queue.waitUntilReady().catch((error) => {
  console.error("[TRANSLATION_V2 QUEUE] Failed to initialize", error);
});

type V2Processor = Processor<TranslationV2JobData, unknown, string>;

let v2Worker: Worker<TranslationV2JobData, unknown, string> | null = null;

export function registerTranslationV2Processor(processor: V2Processor) {
  if (v2Worker) {
    return v2Worker;
  }
  v2Worker = new Worker<TranslationV2JobData>(V2_QUEUE_NAME, processor, {
    connection: createRedisClient("translation-v2-worker"),
    concurrency: 1,
  });
  return v2Worker;
}

export async function enqueueTranslationV2Job(
  data: TranslationV2JobData,
  options?: JobsOptions,
) {
  return v2Queue.add("translation-v2", data, options);
}

export async function removeTranslationV2Job(jobKey: string) {
  const job = await v2Queue.getJob(jobKey);
  if (job) {
    await job.remove();
  }
}

export async function pauseTranslationV2Queue() {
  await v2Queue.pause();
}

export async function closeTranslationV2Queue() {
  await v2Worker?.close();
  await v2Queue.close();
}

export type TranslationV2Job = Job<TranslationV2JobData>;
