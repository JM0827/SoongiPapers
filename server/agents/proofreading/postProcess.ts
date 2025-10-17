import type { IssueItem, ResultBucket } from "./config";

interface FilterOptions {
  maxPerSubfeature?: number;
  minConfidence?: number;
  minSeverity?: "low" | "medium" | "high";
}

const SEVERITY_ORDER: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

const meetsSeverity = (
  value: string | undefined,
  threshold: FilterOptions["minSeverity"],
) => {
  if (!threshold) return true;
  const current = SEVERITY_ORDER[value ?? ""] ?? 0;
  const required = SEVERITY_ORDER[threshold] ?? 0;
  return current >= required;
};

const dedupeKey = (item: IssueItem, bucket: ResultBucket) => {
  const sentenceId = item.en_sentence_id ?? item.kr_sentence_id ?? "n/a";
  const fingerprint = item.after ?? item.recommendation_en ?? item.recommendation_ko ?? "";
  return `${bucket.subfeatureKey}-${sentenceId}-${fingerprint}`;
};

export function filterBuckets(
  buckets: ResultBucket[],
  { maxPerSubfeature = 3, minConfidence = 0.6, minSeverity }: FilterOptions,
) {
  const seen = new Set<string>();

  return buckets.map((bucket) => {
    const filtered = bucket.items
      .filter((item) => {
        if (typeof item.confidence === "number" && item.confidence < minConfidence) {
          if ((item.severity ?? "low") === "low") return false;
        }
        if (!meetsSeverity(item.severity, minSeverity)) return false;
        return true;
      })
      .filter((item) => {
        const key = dedupeKey(item, bucket);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => {
        const aScore = (SEVERITY_ORDER[a.severity ?? ""] ?? 0) * 100 + (a.confidence ?? 0);
        const bScore = (SEVERITY_ORDER[b.severity ?? ""] ?? 0) * 100 + (b.confidence ?? 0);
        return bScore - aScore;
      })
      .slice(0, maxPerSubfeature);

    return {
      ...bucket,
      items: filtered,
    } satisfies ResultBucket;
  });
}

export function recomputeCounts(buckets: ResultBucket[]) {
  const counts: Record<string, number> = {};
  for (const bucket of buckets) {
    counts[bucket.subfeatureLabel] = (counts[bucket.subfeatureLabel] ?? 0) + bucket.items.length;
  }
  return counts;
}
