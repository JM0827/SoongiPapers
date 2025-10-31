export type LocalizeFn = (
  key: string,
  fallback: string,
  params?: Record<string, string | number>,
) => string;
