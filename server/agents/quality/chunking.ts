import { estimateTokens } from "../../services/llm";
import type { AlignedPair } from "./alignedPairs";

export interface QualityChunkDescriptor {
  index: number;
  startPairIndex: number;
  endPairIndex: number;
  overlapPairCount: number;
  pairCount: number;
  sourceText: string;
  translatedText: string;
  sourceLength: number;
  translatedLength: number;
  sourceTokens: number;
  translatedTokens: number;
}

export interface ChunkingOptions {
  tokenBudget: number;
  overlapTokenBudget: number;
}

interface PairWithTokens extends AlignedPair {
  sourceTokens: number;
  translatedTokens: number;
  maxTokens: number;
  sourceLength: number;
  translatedLength: number;
}

const toPairWithTokens = (pair: AlignedPair): PairWithTokens => {
  const source = pair.source ?? "";
  const translated = pair.translated ?? "";
  const sourceTokens = estimateTokens(source);
  const translatedTokens = estimateTokens(translated);
  const maxTokens = Math.max(sourceTokens, translatedTokens);
  return {
    ...pair,
    source,
    translated,
    sourceTokens,
    translatedTokens,
    maxTokens,
    sourceLength: source.length,
    translatedLength: translated.length,
  };
};

const buildBaseChunks = (
  pairs: PairWithTokens[],
  tokenBudget: number,
): Array<{ start: number; end: number }> => {
  const chunks: Array<{ start: number; end: number }> = [];
  let cursor = 0;

  while (cursor < pairs.length) {
    let lastAcceptableEnd = cursor - 1;
    let tokensSource = 0;
    let tokensTranslated = 0;

    for (let index = cursor; index < pairs.length; index += 1) {
      const candidateSourceTokens = tokensSource + pairs[index].sourceTokens;
      const candidateTranslatedTokens =
        tokensTranslated + pairs[index].translatedTokens;
      const needs = Math.max(candidateSourceTokens, candidateTranslatedTokens);
      const allow = needs <= tokenBudget || index === cursor;

      if (!allow) break;

      tokensSource = candidateSourceTokens;
      tokensTranslated = candidateTranslatedTokens;
      lastAcceptableEnd = index;
    }

    if (lastAcceptableEnd < cursor) {
      lastAcceptableEnd = cursor;
    }

    chunks.push({ start: cursor, end: lastAcceptableEnd });
    cursor = lastAcceptableEnd + 1;
  }

  return chunks;
};

const determineOverlapStart = (
  pairs: PairWithTokens[],
  chunkStart: number,
  overlapBudget: number,
): number => {
  if (chunkStart === 0 || overlapBudget <= 0) {
    return chunkStart;
  }

  let tokens = 0;
  let start = chunkStart;

  for (
    let index = chunkStart - 1;
    index >= 0 && tokens < overlapBudget;
    index -= 1
  ) {
    tokens += pairs[index].maxTokens;
    start = index;
  }

  return start;
};

export function buildQualityChunks(
  alignedPairs: AlignedPair[],
  options: ChunkingOptions,
): QualityChunkDescriptor[] {
  const normalized = alignedPairs
    .map(toPairWithTokens)
    .filter((pair) => pair.sourceLength || pair.translatedLength);

  if (!normalized.length) {
    return [];
  }

  const tokenBudget = Math.max(1, options.tokenBudget);
  const baseChunks = buildBaseChunks(normalized, tokenBudget);
  const overlapBudget = Math.max(0, options.overlapTokenBudget);

  return baseChunks.map((baseChunk, chunkIndex) => {
    const startPairIndex =
      chunkIndex === 0
        ? baseChunk.start
        : determineOverlapStart(normalized, baseChunk.start, overlapBudget);
    const endPairIndex = baseChunk.end;
    const slice = normalized.slice(startPairIndex, endPairIndex + 1);

    const sourceTokens = slice.reduce(
      (acc, pair) => acc + pair.sourceTokens,
      0,
    );
    const translatedTokens = slice.reduce(
      (acc, pair) => acc + pair.translatedTokens,
      0,
    );

    const sourceText = slice.map((pair) => pair.source).join("\n");
    const translatedText = slice.map((pair) => pair.translated).join("\n");

    return {
      index: chunkIndex,
      startPairIndex,
      endPairIndex,
      overlapPairCount: Math.max(0, baseChunk.start - startPairIndex),
      pairCount: slice.length,
      sourceText,
      translatedText,
      sourceLength: sourceText.length,
      translatedLength: translatedText.length,
      sourceTokens,
      translatedTokens,
    } satisfies QualityChunkDescriptor;
  });
}
