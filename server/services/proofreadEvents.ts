import { EventEmitter } from "node:events";
import type { AgentItemsResponseV2 } from "./responsesSchemas";

export type ProofreadStageStatus =
  | "queued"
  | "in_progress"
  | "done"
  | "error";

export interface ProofreadStageEvent {
  projectId: string;
  runId: string;
  proofreadingId?: string | null;
  tier?: string | null;
  key?: string | null;
  stage: string;
  status: ProofreadStageStatus;
  label?: string | null;
  message?: string | null;
  itemCount?: number | null;
}

export interface ProofreadPageEvent {
  projectId: string;
  runId: string;
  proofreadingId?: string | null;
  tier?: string | null;
  key?: string | null;
  chunkIndex?: number | null;
  envelope: AgentItemsResponseV2;
}

export interface ProofreadCompleteEvent {
  projectId: string;
  runId: string;
  proofreadingId?: string | null;
  completedAt: string;
  summary?: Record<string, unknown> | null;
  scope?: string | null;
}

export interface ProofreadErrorEvent {
  projectId: string;
  runId: string;
  proofreadingId?: string | null;
  stage?: string | null;
  message: string;
  retryable?: boolean;
  reason?: string | null;
}

export interface ProofreadTierSummaryEvent {
  projectId: string;
  runId: string;
  proofreadingId?: string | null;
  tier: string;
  summary: Record<string, unknown> | null;
  itemCount?: number | null;
  completedAt: string;
}

type ProofreadEventMap = {
  stage: ProofreadStageEvent;
  page: ProofreadPageEvent;
  complete: ProofreadCompleteEvent;
  error: ProofreadErrorEvent;
  tier: ProofreadTierSummaryEvent;
};

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

const channelFor = (runId: string, type: keyof ProofreadEventMap) =>
  `proofread:${type}:${runId}`;

export function emitProofreadStage(event: ProofreadStageEvent): void {
  emitter.emit(channelFor(event.runId, "stage"), event);
}

export function emitProofreadPage(event: ProofreadPageEvent): void {
  emitter.emit(channelFor(event.runId, "page"), event);
}

export function emitProofreadComplete(event: ProofreadCompleteEvent): void {
  emitter.emit(channelFor(event.runId, "complete"), event);
}

export function emitProofreadError(event: ProofreadErrorEvent): void {
  emitter.emit(channelFor(event.runId, "error"), event);
}

export function emitProofreadTierSummary(event: ProofreadTierSummaryEvent): void {
  emitter.emit(channelFor(event.runId, "tier"), event);
}

export function subscribeProofreadEvents<TName extends keyof ProofreadEventMap>(
  runId: string,
  type: TName,
  listener: (event: ProofreadEventMap[TName]) => void,
): () => void {
  const channel = channelFor(runId, type);
  emitter.on(channel, listener);
  return () => emitter.off(channel, listener);
}
