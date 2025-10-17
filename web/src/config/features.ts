export const FEATURE_FLAGS = {
  enableWebPush: true,
  showUsageDashboard: true,
  recommendBestTranslation: true,
} as const;

export const RETRY_POLICY = {
  maxAttempts: 3,
  backoffMs: [2000, 4000, 8000],
} as const;

export const QA_COLOR_RULE = {
  red: 80,
  green: 90,
} as const;
