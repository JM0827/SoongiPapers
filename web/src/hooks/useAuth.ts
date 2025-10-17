import { useCallback } from "react";
import { useAuthStore } from "../store/auth.store";
import { api } from "../services/api";

const GOOGLE_LOGIN = import.meta.env.VITE_OAUTH_URL ?? "/api/auth/google";

export const useAuth = () => {
  const { token, user, setToken, setUser, reset, isHydrating } = useAuthStore();

  const login = useCallback(() => {
    console.info("[auth] redirecting to Google OAuth");
    window.location.assign(GOOGLE_LOGIN);
  }, []);

  const logout = useCallback(() => {
    reset();
  }, [reset]);

  const hydrateProfile = useCallback(
    async (overrideToken?: string) => {
      const nextToken = overrideToken ?? token;
      if (!nextToken) return;
      if (!overrideToken && user) return;
      if (overrideToken) {
        setToken(overrideToken);
        console.info("[auth] stored token from callback");
      }
      try {
        const profile = await api.me(nextToken);
        setUser(profile);
        console.info("[auth] hydrated profile", profile);
      } catch (err) {
        console.warn("[useAuth] Failed to hydrate profile", err);
        reset();
      }
    },
    [token, user, setUser, setToken, reset],
  );

  return {
    token,
    user,
    isHydrating,
    login,
    logout,
    setToken,
    hydrateProfile,
  };
};
