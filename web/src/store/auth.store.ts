import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { UserProfile } from "../types/domain";

interface AuthState {
  token: string | null;
  user: UserProfile | null;
  isHydrating: boolean;
  setToken: (token: string | null) => void;
  setUser: (user: UserProfile | null) => void;
  setHydrating: (value: boolean) => void;
  reset: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      isHydrating: true,
      setToken: (token) => set({ token }),
      setUser: (user) => set({ user }),
      setHydrating: (value) => set({ isHydrating: value }),
      reset: () => set({ token: null, user: null }),
    }),
    {
      name: "t1-auth",
      partialize: (state) => ({ token: state.token, user: state.user }),
      onRehydrateStorage: () => (state) => {
        state?.setHydrating(false);
      },
    },
  ),
);
