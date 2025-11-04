import { useCallback, useEffect, useRef } from "react";
import { useUIStore } from "../store/ui.store";
import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  type UILocale,
} from "../config/i18n";
import { useAuthStore } from "../store/auth.store";
import { api } from "../services/api";

const LOCALE_STORAGE_KEY = "t1.ui-locale";

export const useUILocale = () => {
  const locale = useUIStore((state) => state.locale);
  const rawSetLocale = useUIStore((state) => state.setLocale);
  const token = useAuthStore((state) => state.token);
  const hasSyncedFromServer = useRef(false);

  const setLocale = useCallback(
    (value: string) => {
      if (!isSupportedLocale(value)) {
        console.warn("[useUILocale] Ignoring unsupported locale value", value);
        return;
      }
      const next = value as UILocale;
      rawSetLocale(next);
      if (token) {
        void api
          .updateUserPreferences(token, {
            preferred_language: next,
          })
          .catch((error) => {
            console.warn(
              "[useUILocale] Failed to persist preferred language",
              error,
            );
          });
      }
    },
    [rawSetLocale, token],
  );

  useEffect(() => {
    if (hasSyncedFromServer.current) return;
    if (!token) return;
    if (typeof window === "undefined") return;

    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored && isSupportedLocale(stored)) {
      hasSyncedFromServer.current = true;
      return;
    }

    hasSyncedFromServer.current = true;
    void (async () => {
      try {
        const { preferred_language } = await api.userPreferences(token);
        if (preferred_language && isSupportedLocale(preferred_language)) {
          rawSetLocale(preferred_language as UILocale);
        }
      } catch (error) {
        console.warn(
          "[useUILocale] Failed to load preferred language from server",
          error,
        );
      }
    })();
  }, [token, rawSetLocale]);

  return {
    locale: locale ?? DEFAULT_LOCALE,
    setLocale,
  };
};
