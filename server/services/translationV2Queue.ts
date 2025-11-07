// server/services/translationV2Queue.ts
import {
  Queue,
  QueueEvents,
  Worker,
  type JobsOptions,
  type Processor,
  type Job,
} from "bullmq";
import { createRedisClient, getSharedRedisClient } from "./redis";
import type { OriginSegment } from "../agents/translation/segmentationAgent";
import type { SequentialTranslationStageConfig } from "../agents/translation";
import type { TranslationNotes } from "../models/DocumentProfile";

/**
 * 번역 V2 큐에 넣는 Job Payload
 */
export interface TranslationV2JobData {
  projectId: string;
  jobId: string;
  workflowRunId?: string | null;
  sourceHash?: string | null;
  originLanguage?: string | null;
  targetLanguage?: string | null;
  originSegments?: OriginSegment[];
  originDocumentId?: string | null;
  translationNotes?: TranslationNotes | null;
  projectTitle?: string | null;
  authorName?: string | null;
  synopsis?: string | null;
  register?: string | null;
  candidateCount?: number;
  stageParameters?: SequentialTranslationStageConfig;
}

const V2_QUEUE_NAME = "translation_v2";

/** ENV 기반 타임아웃(디폴트 ms) */
const READY_TIMEOUT_MS = Number(process.env.QUEUE_READY_TIMEOUT_MS ?? 1500);
const ENQUEUE_TIMEOUT_MS = Number(process.env.QUEUE_ENQUEUE_TIMEOUT_MS ?? 1500);

/** 지연 생성 싱글턴(Queue / QueueEvents / Worker) */
let v2Queue: Queue<TranslationV2JobData> | null = null;
let v2QueueEvents: QueueEvents | null = null;
let v2Worker: Worker<TranslationV2JobData, unknown, string> | null = null;

/** 공통 타임아웃 래퍼 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string) {
  return Promise.race<T>([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`${label}_timeout`)), ms),
    ) as unknown as Promise<T>,
  ]);
}

/** Queue/QueueEvents를 실제 호출 시점에 초기화 */
function getV2Queue() {
  if (!v2Queue) {
    const connection = getSharedRedisClient();
    v2Queue = new Queue<TranslationV2JobData>(V2_QUEUE_NAME, { connection });
    // 준비 대기 실패는 로그만 (라우트 레벨에서 별도 타임아웃 가드)
    v2Queue.waitUntilReady().catch((error) => {
      console.error("[TRANSLATION_V2 QUEUE] Failed to initialize", error);
    });
  }
  if (!v2QueueEvents) {
    const connection = getSharedRedisClient();
    v2QueueEvents = new QueueEvents(V2_QUEUE_NAME, { connection });
    v2QueueEvents.waitUntilReady().catch((e) =>
      console.error("[QUEUE-EVENTS] init failed", (e as any)?.message || e),
    );
    // 가벼운 관찰성(원인 추적)
    v2QueueEvents.on("failed", ({ jobId, failedReason }: any) =>
      console.error("[QUEUE] failed", jobId, failedReason || ""),
    );
    v2QueueEvents.on("completed", ({ jobId }: any) =>
      console.log("[QUEUE] completed", jobId),
    );
  }
  return { v2Queue, v2QueueEvents };
}

/** 큐 준비를 짧게만 대기(무한대기 방지) */
async function waitQueueReady(timeoutMs = READY_TIMEOUT_MS) {
  const { v2Queue } = getV2Queue();
  return Promise.race([
    v2Queue.waitUntilReady(),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error("queue_ready_timeout")), timeoutMs),
    ),
  ]);
}

/**
 * 워커 등록(필요 시 한 번만 생성)
 * - WORKER_CONCURRENCY는 ENV(TRANSLATION_V2_WORKER_CONCURRENCY)로 제어
 */
export function registerTranslationV2Processor(processor: V2Processor) {
  if (v2Worker) return v2Worker;

  const WORKER_CONCURRENCY = Number(
    process.env.TRANSLATION_V2_WORKER_CONCURRENCY ?? 1,
  );
  const rawLockDuration = Number(process.env.TRANSLATION_V2_LOCK_DURATION_MS ?? 240_000);
  const rawStalledInterval = Number(
    process.env.TRANSLATION_V2_STALLED_INTERVAL_MS ?? 60_000,
  );
  const rawMaxStalledCount = Number(
    process.env.TRANSLATION_V2_MAX_STALLED_COUNT ?? 2,
  );

  const lockDuration = Number.isFinite(rawLockDuration) && rawLockDuration > 0
    ? Math.max(60_000, Math.floor(rawLockDuration))
    : 240_000;
  const stalledInterval = Number.isFinite(rawStalledInterval) && rawStalledInterval > 0
    ? Math.max(15_000, Math.floor(rawStalledInterval))
    : 60_000;
  const maxStalledCount = Number.isFinite(rawMaxStalledCount) && rawMaxStalledCount > 0
    ? Math.max(1, Math.floor(rawMaxStalledCount))
    : 2;

  v2Worker = new Worker<TranslationV2JobData>(V2_QUEUE_NAME, processor, {
    connection: createRedisClient("translation-v2-worker"),
    concurrency: WORKER_CONCURRENCY,
    lockDuration,
    stalledInterval,
    maxStalledCount,
    // 필요 시 레이트리미터 추가
    // limiter: { max: Number(process.env.TRANSLATION_V2_MAX_JOBS_PER_SEC ?? 2), duration: 1000 },
  });

  // 워커 관찰성
  v2Worker.on("completed", (job) => {
    console.log("[WORKER] done", job.id);
  });
  v2Worker.on("failed", (job, err) => {
    console.error("[WORKER] fail", job?.id, (err as Error)?.message || err);
  });

  return v2Worker;
}

type V2Processor = Processor<TranslationV2JobData, unknown, string>;

/**
 * 큐에 Job 등록
 * - 준비 타임아웃 + add 타임아웃 (무한대기 방지)
 * - 동일 projectId 중복 큐잉 방지(jobId 디듀프)
 * - 기본 재시도/백오프/보존 정책 적용(옵션 override 허용)
 */
export async function enqueueTranslationV2Job(
  data: TranslationV2JobData,
  options?: JobsOptions,
) {
  console.log("[QUEUE] enqueue: enter", {
    projectId: data.projectId,
    segs: Array.isArray(data.originSegments) ? data.originSegments.length : -1,
  });

  const { v2Queue } = getV2Queue();

  // 큐 준비를 짧게만 대기 → 실패 시 예외(라우트에서 try/catch)
  await waitQueueReady();
  console.log("[QUEUE] enqueue: ready");

  // 같은 projectId 중복 큐잉 방지용 jobId 고정(옵션/데이터 우선)
  const dedupeJobId =
    options?.jobId ?? data.jobId ?? `${V2_QUEUE_NAME}:${data.projectId}`;

  const merged: JobsOptions = {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 86400, count: 1000 },
    jobId: dedupeJobId,
    ...options,
  };

  // add() 자체에도 타임아웃 적용 (불안정 연결 시 무한대기 차단)
  const job = await withTimeout(
    v2Queue.add("translation-v2", data, merged),
    ENQUEUE_TIMEOUT_MS,
    "enqueue",
  );

  console.log("[QUEUE] enqueue: ok", { bullJobId: job.id });
  return job;
}

/** 특정 Job 제거 */
export async function removeTranslationV2Job(jobKey: string) {
  const { v2Queue } = getV2Queue();
  const job = await v2Queue.getJob(jobKey);
  if (job) {
    await job.remove();
  }
}

/** 큐 일시 중지 */
export async function pauseTranslationV2Queue() {
  const { v2Queue } = getV2Queue();
  await v2Queue.pause();
}

/** 큐/워커 종료(개발 종료/재시작 시) */
export async function closeTranslationV2Queue() {
  await v2Worker?.close();
  await v2Queue?.close();
  await v2QueueEvents?.close();
  v2Worker = null;
  v2Queue = null;
  v2QueueEvents = null;
}

/** 외부에서 쓰는 타입 alias */
export type TranslationV2Job = Job<TranslationV2JobData>;
