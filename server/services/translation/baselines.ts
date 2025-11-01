import type { BaselineMetrics } from "../../agents/translation";

const SENTIMENT_WORDS = new Set([
  "love",
  "hate",
  "fear",
  "joy",
  "sad",
  "angry",
  "calm",
  "tension",
  "hope",
  "despair",
]);

export async function ensureBaseline(
  segmentText: string,
): Promise<BaselineMetrics> {
  const words = segmentText
    .split(/\s+/)
    .map((word) => word.toLowerCase().replace(/[^a-z]/g, ""))
    .filter(Boolean);

  const uniqueWords = new Set(words);
  const sentimentHits = words.filter((word) =>
    SENTIMENT_WORDS.has(word),
  ).length;

  return {
    emotion: {
      vector: [sentimentHits / Math.max(words.length, 1)],
      topLabels: sentimentHits > 0 ? ["emotive"] : ["neutral"],
      strength: Math.min(1, sentimentHits / 5),
      confidence: 0.5,
    },
    vividness: {
      lexical_diversity: Number(
        (uniqueWords.size / Math.max(words.length, 1)).toFixed(3),
      ),
      concreteness: Math.min(1, words.length / 120),
      sensory_density: Math.min(1, sentimentHits / 10),
      vividness: Math.min(1, sentimentHits / 8 + uniqueWords.size / 200),
      confidence: 0.4,
    },
    metaphor: {
      items: [],
      confidence: 0.2,
    },
    styleRhythm: {
      mean: words.length / Math.max(segmentText.split(/\./).length, 1),
      sd: 0,
    },
  } satisfies BaselineMetrics;
}
