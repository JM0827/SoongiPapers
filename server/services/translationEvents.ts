import { EventEmitter } from "node:events";
import type { AgentItemsResponseV2 } from "./responsesSchemas";
import {
  updatePaginationMetrics,
  updateStageTimeline,
} from "./translationSummaryState";

export type TranslationStageStatus =
  | "queued"
  | "in_progress"
  | "done"
  | "error";

export const translationRunId = (jobId: string): string =>
  jobId.startsWith("translation:") ? jobId : `translation:${jobId}`;

export interface TranslationStageEvent {
  projectId: string;
  jobId: string;
  runId: string;
  stage: string;
  status: TranslationStageStatus;
  label?: string | null;
  message?: string | null;
  itemCount?: number | null;
  chunkId?: string | null;
}

export interface TranslationPageEvent {
  projectId: string;
  jobId: string;
  runId: string;
  stage: string;
  envelope: AgentItemsResponseV2;
}

export interface TranslationCompleteEvent {
  projectId: string;
  jobId: string;
  runId: string;
  translationFileId: string | null;
  completedAt: string;
}

export interface TranslationErrorEvent {
  projectId: string;
  jobId: string;
  runId: string;
  message: string;
  stage?: string | null;
  retryable?: boolean;
}

type TranslationListener<T> = (event: T) => void;

type TranslationEventMap = {
  stage: TranslationStageEvent;
  page: TranslationPageEvent;
  complete: TranslationCompleteEvent;
  error: TranslationErrorEvent;
};

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

function channelFor(jobId: string, type: keyof TranslationEventMap): string {
  return `translation:${type}:${jobId}`;
}

export function emitTranslationStage(event: TranslationStageEvent): void {
  void updateStageTimeline({
    projectId: event.projectId,
    runId: event.runId,
    stage: event.stage,
    status: event.status,
    itemCount: event.itemCount ?? null,
  }).catch((error) => {
    // eslint-disable-next-line no-console -- temporary visibility during refactor
    console.warn("[TranslationSummary] failed to record stage timeline", {
      runId: event.runId,
      stage: event.stage,
      error,
    });
  });
  emitter.emit(channelFor(event.jobId, "stage"), event);
}

export function emitTranslationPage(event: TranslationPageEvent): void {
  const hasMore = Boolean(event.envelope.has_more);
  const nextCursor =
    typeof event.envelope.next_cursor === "string"
      ? event.envelope.next_cursor
      : null;
  void updatePaginationMetrics({
    projectId: event.projectId,
    runId: event.runId,
    hasMore,
    nextCursor,
    stage: event.stage,
  }).catch((error) => {
    // eslint-disable-next-line no-console -- temporary visibility during refactor
    console.warn("[TranslationSummary] failed to record pagination", {
      runId: event.runId,
      stage: event.stage,
      error,
    });
  });
  emitter.emit(channelFor(event.jobId, "page"), event);
}

export function emitTranslationComplete(event: TranslationCompleteEvent): void {
  emitter.emit(channelFor(event.jobId, "complete"), event);
}

export function emitTranslationError(event: TranslationErrorEvent): void {
  emitter.emit(channelFor(event.jobId, "error"), event);
}

export function subscribeTranslationEvents<TName extends keyof TranslationEventMap>(
  jobId: string,
  type: TName,
  listener: TranslationListener<TranslationEventMap[TName]>,
): () => void {
  const channel = channelFor(jobId, type);
  emitter.on(channel, listener);
  return () => emitter.off(channel, listener);
}
