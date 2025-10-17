import { create } from "zustand";

type IssueHandler = (issueId: string) => Promise<boolean>;

interface ProofreadIssueActionState {
  applyIssue: IssueHandler | null;
  ignoreIssue: IssueHandler | null;
  explainIssue: ((issueId: string) => void) | null;
  setHandlers: (handlers: {
    applyIssue?: IssueHandler | null;
    ignoreIssue?: IssueHandler | null;
    explainIssue?: ((issueId: string) => void) | null;
  }) => void;
  resetHandlers: () => void;
}

export const useProofreadIssueActionStore = create<ProofreadIssueActionState>(
  (set) => ({
    applyIssue: null,
    ignoreIssue: null,
    explainIssue: null,
    setHandlers: (handlers) =>
      set((state) => ({
        applyIssue:
          handlers.applyIssue !== undefined
            ? handlers.applyIssue
            : state.applyIssue,
        ignoreIssue:
          handlers.ignoreIssue !== undefined
            ? handlers.ignoreIssue
            : state.ignoreIssue,
        explainIssue:
          handlers.explainIssue !== undefined
            ? handlers.explainIssue
            : state.explainIssue,
      })),
    resetHandlers: () =>
      set({ applyIssue: null, ignoreIssue: null, explainIssue: null }),
  }),
);
