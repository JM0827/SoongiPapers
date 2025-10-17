export type UILocale = "ko" | "en";

const rawLocales = (import.meta.env.VITE_SUPPORTED_LOCALES ?? "ko,en")
  .split(",")
  .map((locale: string) => locale.trim())
  .filter((locale: string) => Boolean(locale));

const KNOWN_LOCALES = new Set<UILocale>(["ko", "en"]);

export const SUPPORTED_LOCALES = rawLocales
  .filter((locale: string): locale is UILocale =>
    KNOWN_LOCALES.has(locale as UILocale),
  )
  .sort();

export const DEFAULT_LOCALE = (import.meta.env.VITE_DEFAULT_LOCALE ??
  "ko") as UILocale;

export const isSupportedLocale = (locale: string): locale is UILocale =>
  SUPPORTED_LOCALES.includes(locale as UILocale);
