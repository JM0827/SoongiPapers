import { create } from "zustand";
import type { ChatAction } from "../types/domain";

type Executor = ((action: ChatAction) => void | Promise<void>) | null;

interface ChatActionState {
  executor: Executor;
  setExecutor: (executor: Executor) => void;
  execute: (action: ChatAction) => Promise<void>;
}

export const useChatActionStore = create<ChatActionState>((set, get) => ({
  executor: null,
  setExecutor: (executor) => set({ executor }),
  execute: async (action) => {
    const executor = get().executor;
    if (!executor) {
      throw new Error("Chat action handler is not available");
    }
    await Promise.resolve(executor(action));
  },
}));
