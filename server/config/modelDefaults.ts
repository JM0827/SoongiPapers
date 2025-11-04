const envPrimary =
  process.env.PROOFREADING_MODEL ?? undefined;
const envFallback =
  process.env.PROOFREADING_MODEL_FALLBACK ?? undefined;

export const DEFAULT_PROOFREADING_MODEL = envPrimary?.trim() || "gpt-5";

export const FALLBACK_PROOFREADING_MODEL = envFallback?.trim() || "gpt-5-mini";

export function getProofreadModelSequence(preferred?: string | null): string[] {
  const sequence: string[] = [];
  const primary = (preferred ?? DEFAULT_PROOFREADING_MODEL).trim();
  if (primary) {
    sequence.push(primary);
  }
  const fallback = FALLBACK_PROOFREADING_MODEL.trim();
  if (fallback && !sequence.includes(fallback)) {
    sequence.push(fallback);
  }
  return sequence;
}
