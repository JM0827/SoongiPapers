import { create } from "zustand";
import type { JobSequentialSummary } from "../types/domain";

export type TranslationStatus =
  | "idle"
  | "queued"
  | "running"
  | "recovering"
  | "done"
  | "failed"
  | "cancelled";
export type ProofreadingStatus =
  | "idle"
  | "queued"
  | "running"
  | "recovering"
  | "done"
  | "failed";
export type QualityStatus =
  | "idle"
  | "running"
  | "recovering"
  | "done"
  | "failed";

export type AgentRunStatus = TranslationStatus;

export interface AgentRunState {
  status: AgentRunStatus;
  heartbeatAt: number | null;
  willRetry: boolean;
  nextRetryDelayMs: number | null;
}

export interface AgentSubState {
  id: string;
  status: "running" | "retrying" | "done" | "failed";
  label?: string | null;
  error?: string | null;
}

export interface QualityChunkSummary {
  index: number;
  status:
    | "pending"
    | "running"
    | "completed"
    | "error"
    | "partial"
    | "fallback";
  score: number | null;
  durationMs: number | null;
  requestId?: string | null;
  maxOutputTokensUsed?: number | null;
  usage?: {
    promptTokens?: number | null;
    completionTokens?: number | null;
    totalTokens?: number | null;
  } | null;
  message?: string | null;
  fallbackApplied?: boolean;
  missingFields?: string[];
  attempts?: number | null;
  preview?: string | null;
}

export interface TranslationAgentState {
  status: TranslationStatus;
  jobId: string | null;
  progressCompleted: number;
  progressTotal: number;
  stageCounts: Record<string, number>;
  completedStages: string[];
  currentStage: string | null;
  needsReviewCount: number;
  totalSegments: number;
  guardFailures: Record<string, number>;
  flaggedSegments: JobSequentialSummary["flaggedSegments"];
  pipelineStages: string[];
  lastError: string | null;
  lastMessage: string | null;
  updatedAt: string | null;
  projectId: string | null;
  run: AgentRunState;
  subStates: AgentSubState[];
}

export interface ProofreadingAgentState {
  status: ProofreadingStatus;
  proofreadingId: string | null;
  lastMessage: string | null;
  lastError: string | null;
  updatedAt: string | null;
  stageStatuses: Array<{
    tier?: string | null;
    key?: string | null;
    label?: string | null;
    status: string;
  }>;
  projectId: string | null;
  activityLog: Array<{
    id: string;
    timestamp: string;
    type: string;
    message: string;
    meta?: Record<string, unknown> | null;
  }>;
  tierSummaries: Record<
    string,
    {
      label?: string | null;
      itemCount: number;
      completedAt: string;
    }
  >;
  completionSummary: null | {
    totalIssues: number;
    countsBySubfeature: Record<string, number>;
    tierIssueCounts: Record<string, number>;
    notesKo?: string | null;
    notesEn?: string | null;
  };
  lastHeartbeatAt: string | null;
  isStalled: boolean;
  run: AgentRunState;
  subStates: AgentSubState[];
}

export interface QualityAgentState {
  status: QualityStatus;
  score: number | null;
  lastError: string | null;
  updatedAt: string | null;
  projectId: string | null;
  chunksTotal: number;
  chunksCompleted: number;
  currentChunkIndex: number | null;
  chunkSummaries: QualityChunkSummary[];
  lastMessage: string | null;
  run: AgentRunState;
  subStates: AgentSubState[];
}

interface WorkflowState {
  translation: TranslationAgentState;
  proofreading: ProofreadingAgentState;
  quality: QualityAgentState;
  setTranslation: (
    projectId: string | null,
    update:
      | Partial<TranslationAgentState>
      | ((current: TranslationAgentState) => Partial<TranslationAgentState>),
  ) => void;
  resetTranslation: (projectId?: string | null) => void;
  setProofreading: (
    projectId: string | null,
    update:
      | Partial<ProofreadingAgentState>
      | ((current: ProofreadingAgentState) => Partial<ProofreadingAgentState>),
  ) => void;
  resetProofreading: (projectId?: string | null) => void;
  setQuality: (
    projectId: string | null,
    update:
      | Partial<QualityAgentState>
      | ((current: QualityAgentState) => Partial<QualityAgentState>),
  ) => void;
  resetQuality: (projectId?: string | null) => void;
}

const defaultRunState: AgentRunState = {
  status: "idle",
  heartbeatAt: null,
  willRetry: false,
  nextRetryDelayMs: null,
};

const buildRunState = (
  base: AgentRunState,
  status: AgentRunState["status"],
  overrides?: Partial<AgentRunState>,
): AgentRunState => ({
  status,
  heartbeatAt: overrides?.heartbeatAt ?? Date.now(),
  willRetry: overrides?.willRetry ?? base.willRetry ?? false,
  nextRetryDelayMs:
    overrides?.nextRetryDelayMs ?? base.nextRetryDelayMs ?? null,
});

const defaultTranslationState: TranslationAgentState = {
  status: "idle",
  jobId: null,
  progressCompleted: 0,
  progressTotal: 0,
  stageCounts: {},
  completedStages: [],
  currentStage: null,
  needsReviewCount: 0,
  totalSegments: 0,
  guardFailures: {},
  flaggedSegments: [],
  pipelineStages: [],
  lastError: null,
  lastMessage: null,
  updatedAt: null,
  projectId: null,
  run: { ...defaultRunState },
  subStates: [],
};

const defaultProofreadingState: ProofreadingAgentState = {
  status: "idle",
  proofreadingId: null,
  lastMessage: null,
  lastError: null,
  updatedAt: null,
  stageStatuses: [],
  projectId: null,
  activityLog: [],
  tierSummaries: {},
  completionSummary: null,
  lastHeartbeatAt: null,
  isStalled: false,
  run: { ...defaultRunState },
  subStates: [],
};

const defaultQualityState: QualityAgentState = {
  status: "idle",
  score: null,
  lastError: null,
  updatedAt: null,
  projectId: null,
  chunksTotal: 0,
  chunksCompleted: 0,
  currentChunkIndex: null,
  chunkSummaries: [],
  lastMessage: null,
  run: { ...defaultRunState },
  subStates: [],
};

export const useWorkflowStore = create<WorkflowState>((set) => ({
  translation: { ...defaultTranslationState },
  proofreading: { ...defaultProofreadingState },
  quality: { ...defaultQualityState },
  setTranslation: (projectId, update) =>
    set((state) => {
      if (!projectId) return {};
      if (
        state.translation.projectId &&
        state.translation.projectId !== projectId
      ) {
        return {};
      }
      const base =
        state.translation.projectId === projectId
          ? state.translation
          : { ...defaultTranslationState, projectId };
      const patch = typeof update === "function" ? update(base) : update;
      const { run: runPatch, subStates: subPatch, ...restPatch } = patch;
      const desiredStatus = (runPatch?.status ??
        restPatch.status ??
        base.status) as TranslationStatus;
      const nextRun = runPatch
        ? buildRunState(base.run, runPatch.status ?? desiredStatus, runPatch)
        : desiredStatus !== base.run.status
          ? buildRunState(base.run, desiredStatus)
          : base.run;
      const nextSubStates = subPatch ?? base.subStates;
      const nextStatus = desiredStatus;
      return {
        translation: {
          ...base,
          ...restPatch,
          status: nextStatus,
          run: nextRun,
          subStates: nextSubStates,
          projectId,
        },
      };
    }),
  resetTranslation: (projectId = null) =>
    set({
      translation: {
        ...defaultTranslationState,
        projectId,
        run: { ...defaultRunState, status: "idle" },
      },
    }),
  setProofreading: (projectId, update) =>
    set((state) => {
      if (!projectId) return {};
      if (
        state.proofreading.projectId &&
        state.proofreading.projectId !== projectId
      ) {
        return {};
      }
      const base =
        state.proofreading.projectId === projectId
          ? state.proofreading
          : { ...defaultProofreadingState, projectId };
      const patch = typeof update === "function" ? update(base) : update;
      const { run: runPatch, subStates: subPatch, ...restPatch } = patch;
      const desiredStatus = (runPatch?.status ??
        restPatch.status ??
        base.status) as ProofreadingStatus;
      const nextRun = runPatch
        ? buildRunState(base.run, runPatch.status ?? desiredStatus, runPatch)
        : desiredStatus !== base.run.status
          ? buildRunState(base.run, desiredStatus)
          : base.run;
      const nextSubStates = subPatch ?? base.subStates;
      const nextStatus = desiredStatus;
      return {
        proofreading: {
          ...base,
          ...restPatch,
          status: nextStatus,
          run: nextRun,
          subStates: nextSubStates,
          projectId,
        },
      };
    }),
  resetProofreading: (projectId = null) =>
    set({
      proofreading: {
        ...defaultProofreadingState,
        projectId,
        run: { ...defaultRunState, status: "idle" },
      },
    }),
  setQuality: (projectId, update) =>
    set((state) => {
      if (!projectId) return {};
      if (state.quality.projectId && state.quality.projectId !== projectId) {
        return {};
      }
      const base =
        state.quality.projectId === projectId
          ? state.quality
          : { ...defaultQualityState, projectId };
      const patch = typeof update === "function" ? update(base) : update;
      const { run: runPatch, subStates: subPatch, ...restPatch } = patch;
      const desiredStatus = (runPatch?.status ??
        restPatch.status ??
        base.status) as QualityStatus;
      const nextRun = runPatch
        ? buildRunState(base.run, runPatch.status ?? desiredStatus, runPatch)
        : desiredStatus !== base.run.status
          ? buildRunState(base.run, desiredStatus)
          : base.run;
      const nextSubStates = subPatch ?? base.subStates;
      const nextStatus = desiredStatus;
      return {
        quality: {
          ...base,
          ...restPatch,
          status: nextStatus,
          run: nextRun,
          subStates: nextSubStates,
          projectId,
        },
      };
    }),
  resetQuality: (projectId = null) =>
    set({
      quality: {
        ...defaultQualityState,
        projectId,
        run: { ...defaultRunState, status: "idle" },
      },
    }),
}));

export type WorkflowStore = ReturnType<typeof useWorkflowStore>;
