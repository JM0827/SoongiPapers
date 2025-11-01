const envPrimary =
  process.env.PROOFREADING_MODEL ?? process.env.PROOFREAD_MODEL ?? undefined;
const envFallback =
  process.env.PROOFREADING_MODEL_FALLBACK ??
  process.env.PROOFREAD_MODEL_FALLBACK ??
  undefined;

export const DEFAULT_PROOFREAD_MODEL = envPrimary?.trim() || "gpt-5";

export const FALLBACK_PROOFREAD_MODEL = envFallback?.trim() || "gpt-5-mini";

export function getProofreadModelSequence(preferred?: string | null): string[] {
  const sequence: string[] = [];
  const primary = (preferred ?? DEFAULT_PROOFREAD_MODEL).trim();
  if (primary) {
    sequence.push(primary);
  }
  const fallback = FALLBACK_PROOFREAD_MODEL.trim();
  if (fallback && !sequence.includes(fallback)) {
    sequence.push(fallback);
  }
  return sequence;
}
