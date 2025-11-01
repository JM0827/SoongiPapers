import { create } from "zustand";

export type StartProofreadFn = (options?: {
  label?: string | null;
  allowParallel?: boolean;
  runDeep?: boolean;
}) => Promise<void>;

interface ProofreadCommandState {
  startProofread: StartProofreadFn | null;
  setStartProofread: (handler: StartProofreadFn | null) => void;
}

export const useProofreadCommandStore = create<ProofreadCommandState>(
  (set) => ({
    startProofread: null,
    setStartProofread: (handler) => set({ startProofread: handler }),
  }),
);
