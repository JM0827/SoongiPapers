import { Queue, Worker, type JobsOptions } from "bullmq";
import type { Processor, Job } from "bullmq";
import {
  getTranslationConcurrency,
  type SegmentationMode,
} from "../config/appControlConfiguration";
import { createRedisClient } from "./redis";
import type { OriginSegment } from "../agents/translation/segmentationAgent";
import type { TranslationNotes } from "../models/DocumentProfile";

export interface TranslationDraftJobData {
  projectId: string;
  jobId: string;
  draftId: string;
  workflowRunId?: string | null;
  runOrder: number;
  totalPasses: number;
  sourceHash: string;
  segmentationMode: SegmentationMode;
  originLanguage?: string | null;
  targetLanguage?: string | null;
  originSegments: OriginSegment[];
  translationNotes?: TranslationNotes | null;
  draftConfig?: {
    model?: string;
    temperature?: number;
    topP?: number;
  };
}

export interface TranslationSynthesisJobData {
  projectId: string;
  jobId: string;
  workflowRunId?: string | null;
  synthesisId?: string | null;
  sourceHash: string;
  segmentationMode: SegmentationMode;
  originLanguage?: string | null;
  targetLanguage?: string | null;
  originSegments: OriginSegment[];
  translationNotes?: TranslationNotes | null;
  candidateDraftIds: string[];
  synthesisConfig?: {
    model?: string;
    temperature?: number;
    topP?: number;
  };
}

const DRAFT_QUEUE_NAME = "translation_drafts";
const SYNTHESIS_QUEUE_NAME = "translation_synthesis";

const draftQueue = new Queue<TranslationDraftJobData>(DRAFT_QUEUE_NAME, {
  connection: createRedisClient("translation-draft-queue"),
});
draftQueue.waitUntilReady().catch((error: unknown) => {
  console.error(
    "[TRANSLATION QUEUE] Failed to initialize draft queue",
    error,
  );
});

const synthesisQueue = new Queue<TranslationSynthesisJobData>(
  SYNTHESIS_QUEUE_NAME,
  {
    connection: createRedisClient("translation-synthesis-queue"),
  },
);
synthesisQueue.waitUntilReady().catch((error: unknown) => {
  console.error(
    "[TRANSLATION QUEUE] Failed to initialize synthesis queue",
    error,
  );
});

type DraftProcessor = Processor<TranslationDraftJobData, unknown, string>;
type SynthesisProcessor = Processor<TranslationSynthesisJobData, unknown, string>;

let draftWorker: Worker<TranslationDraftJobData, unknown, string> | null = null;
let synthesisWorker: Worker<TranslationSynthesisJobData, unknown, string> | null = null;

export function registerTranslationDraftProcessor(processor: DraftProcessor) {
  if (draftWorker) {
    return draftWorker;
  }
  draftWorker = new Worker<TranslationDraftJobData>(
    DRAFT_QUEUE_NAME,
    processor,
    {
      connection: createRedisClient("translation-draft-worker"),
      concurrency: getTranslationConcurrency(),
    },
  );
  return draftWorker;
}

export function registerTranslationSynthesisProcessor(
  processor: SynthesisProcessor,
) {
  if (synthesisWorker) {
    return synthesisWorker;
  }
  synthesisWorker = new Worker<TranslationSynthesisJobData>(
    SYNTHESIS_QUEUE_NAME,
    processor,
    {
      connection: createRedisClient("translation-synthesis-worker"),
      concurrency: 1,
    },
  );
  return synthesisWorker;
}

export async function enqueueTranslationDraftJob(
  data: TranslationDraftJobData,
  options?: JobsOptions,
) {
  return draftQueue.add("translation-draft", data, options);
}

export async function enqueueTranslationSynthesisJob(
  data: TranslationSynthesisJobData,
  options?: JobsOptions,
) {
  return synthesisQueue.add("translation-synthesis", data, options);
}

export async function pauseTranslationQueues() {
  await Promise.all([draftQueue.pause(), synthesisQueue.pause()]);
}

export async function closeTranslationQueues() {
  await Promise.all([
    draftWorker?.close(),
    draftQueue.close(),
    synthesisWorker?.close(),
    synthesisQueue.close(),
  ]);
}

export type TranslationDraftJob = Job<TranslationDraftJobData>;
export type TranslationSynthesisJob = Job<TranslationSynthesisJobData>;

export async function removeDraftQueueJob(jobKey: string) {
  const job = await draftQueue.getJob(jobKey);
  if (job) {
    await job.remove();
  }
}

export async function removeSynthesisQueueJob(jobKey: string) {
  const job = await synthesisQueue.getJob(jobKey);
  if (job) {
    await job.remove();
  }
}
