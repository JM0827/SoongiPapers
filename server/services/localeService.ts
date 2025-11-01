import * as fs from "fs";
import * as path from "path";

export type UILocale = "ko" | "en";

const SUPPORTED_LOCALES = new Set<UILocale>(["ko", "en"]);
export const DEFAULT_LOCALE: UILocale = "ko";

const localeCache: Partial<Record<UILocale, Record<string, string>>> = {};

const hasHangulRegexp = /[\uac00-\ud7af]/;

const interpolate = (
  template: string,
  params?: Record<string, string | number>,
): string => {
  if (!params) return template;
  let result = template;
  for (const [token, value] of Object.entries(params)) {
    const placeholder = `{{${token}}}`;
    if (result.includes(placeholder)) {
      result = result.split(placeholder).join(String(value));
    }
  }
  return result;
};

const resolveCandidateRoots = (): string[] => {
  const roots = new Set<string>();
  const cwd = process.cwd();
  if (cwd) roots.add(path.resolve(cwd));
  roots.add(path.resolve(cwd, ".."));
  roots.add(path.resolve(__dirname, "..", ".."));
  roots.add(path.resolve(__dirname, "..", "..", ".."));
  return Array.from(roots);
};

const findLocaleFile = (locale: UILocale): string | null => {
  const candidates = resolveCandidateRoots().map((root) =>
    path.resolve(root, "web", "src", "locales", `${locale}.json`),
  );
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch (error) {
      // ignore filesystem access errors and try next candidate
    }
  }
  return null;
};

const loadLocaleData = (locale: UILocale): Record<string, string> => {
  if (!localeCache[locale]) {
    const filePath = findLocaleFile(locale);
    if (!filePath) {
      throw new Error(`Locale file for ${locale} not found`);
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    localeCache[locale] = JSON.parse(raw) as Record<string, string>;
  }
  return localeCache[locale]!;
};

const normalizeLocale = (value?: string | null): UILocale | null => {
  if (!value) return null;
  const lower = value.toLowerCase();
  return SUPPORTED_LOCALES.has(lower as UILocale) ? (lower as UILocale) : null;
};

export const isSupportedLocale = (value?: string | null): value is UILocale =>
  Boolean(normalizeLocale(value));

export const detectLocaleFromMessage = (text?: string | null): UILocale => {
  if (!text || !text.trim()) {
    return DEFAULT_LOCALE;
  }
  return hasHangulRegexp.test(text) ? "ko" : "en";
};

export const resolveLocale = (
  ...candidates: Array<string | null | undefined>
): UILocale => {
  for (const candidate of candidates) {
    const normalized = normalizeLocale(candidate);
    if (normalized) return normalized;
  }
  return DEFAULT_LOCALE;
};

export const translate = (
  key: string,
  locale?: string | null,
  params?: Record<string, string | number>,
): string => {
  const resolved = normalizeLocale(locale) ?? DEFAULT_LOCALE;
  const dictionary = loadLocaleData(resolved);
  const fallbackDictionary =
    resolved === DEFAULT_LOCALE ? dictionary : loadLocaleData(DEFAULT_LOCALE);
  const template = dictionary[key] ?? fallbackDictionary[key];
  if (!template) {
    return key;
  }
  return interpolate(template, params);
};
