import { useCallback } from "react";
import { useUIStore } from "../store/ui.store";
import { DEFAULT_LOCALE, isSupportedLocale } from "../config/i18n";

export const useUILocale = () => {
  const locale = useUIStore((state) => state.locale);
  const rawSetLocale = useUIStore((state) => state.setLocale);

  const setLocale = useCallback(
    (value: string) => {
      if (isSupportedLocale(value)) {
        rawSetLocale(value);
        return;
      }
      console.warn(
        "[useUILocale] Ignoring unsupported locale value",
        value,
      );
    },
    [rawSetLocale],
  );

  return {
    locale: locale ?? DEFAULT_LOCALE,
    setLocale,
  };
};
