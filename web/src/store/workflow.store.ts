import { create } from "zustand";
import type { JobSequentialSummary } from "../types/domain";

export type TranslationStatus =
  | "idle"
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "cancelled";
export type ProofreadingStatus =
  | "idle"
  | "queued"
  | "running"
  | "done"
  | "failed";
export type QualityStatus = "idle" | "running" | "done" | "failed";

export interface QualityChunkSummary {
  index: number;
  status: "pending" | "running" | "completed" | "error" | "partial" | "fallback";
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
      return { translation: { ...base, ...patch, projectId } };
    }),
  resetTranslation: (projectId = null) =>
    set({ translation: { ...defaultTranslationState, projectId } }),
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
      return { proofreading: { ...base, ...patch, projectId } };
    }),
  resetProofreading: (projectId = null) =>
    set({ proofreading: { ...defaultProofreadingState, projectId } }),
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
      return { quality: { ...base, ...patch, projectId } };
    }),
  resetQuality: (projectId = null) =>
    set({ quality: { ...defaultQualityState, projectId } }),
}));

export type WorkflowStore = ReturnType<typeof useWorkflowStore>;
