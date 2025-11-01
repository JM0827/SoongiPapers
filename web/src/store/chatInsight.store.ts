import { create } from "zustand";

export type ProofIssueInsight = {
  type: "proofIssue";
  id: string;
  issueId: string;
  title: string;
  summary?: string | null;
  before?: string | null;
  after?: string | null;
  severity?: string | null;
  bucket?: string | null;
  location?: string | null;
  tags?: string[] | null;
  warnings?: string[] | null;
  confidence?: number | null;
};

export type ProofIssueSummaryInsight = {
  type: "proofIssueSummary";
  id: string;
  proofreadingId: string | null;
  totalCount: number;
  pendingCount: number;
  appliedCount: number;
  ignoredCount: number;
  resolvedCount: number;
  errorCount: number;
  counts: Record<"critical" | "high" | "medium" | "low", number>;
  segmentCount: number;
  exampleIssues: Array<{
    issueId: string;
    title: string;
    severity: "critical" | "high" | "medium" | "low";
    location?: string | null;
  }>;
  issuedAt: string;
  readyForQuality: boolean;
};

export type ChatInsight = ProofIssueInsight | ProofIssueSummaryInsight;

interface ChatInsightState {
  queue: ChatInsight[];
  enqueue: (insight: ChatInsight) => void;
  upsertProofSummary: (
    insight: Omit<ProofIssueSummaryInsight, "id" | "type"> & {
      id?: string;
    },
  ) => void;
  dequeue: () => ChatInsight | undefined;
  clear: () => void;
}

export const useChatInsightStore = create<ChatInsightState>((set) => ({
  queue: [],
  enqueue: (insight) => set((state) => ({ queue: [...state.queue, insight] })),
  upsertProofSummary: (insight) =>
    set((state) => {
      const key = insight.proofreadingId ?? "global";
      const id = insight.id ?? `proof-summary:${key}`;
      const payload: ProofIssueSummaryInsight = {
        ...insight,
        id,
        type: "proofIssueSummary",
      };
      const next = [...state.queue];
      const index = next.findIndex(
        (item) =>
          item.type === "proofIssueSummary" &&
          item.proofreadingId === payload.proofreadingId,
      );
      if (index >= 0) {
        next[index] = payload;
      } else {
        next.push(payload);
      }
      return { queue: next };
    }),
  dequeue: () => {
    let next: ChatInsight | undefined;
    set((state) => {
      if (!state.queue.length) {
        next = undefined;
        return state;
      }
      const [first, ...rest] = state.queue;
      next = first;
      return { queue: rest };
    });
    return next;
  },
  clear: () => set({ queue: [] }),
}));
