import type { Spec, ResultBucket, IssueItem } from "./config";
import {
  getEmbeddingsForLists,
  alignByEmbeddingsDP,
} from "./embeddingsAligner";

// ---------- 텍스트/문장 분할 ----------
export function normalizeWhitespace(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[ \u00A0]+/g, " ")
    .trim();
}
function splitKoreanSentences(text: string): string[] {
  const normalized = normalizeWhitespace(text);
  return normalized
    .split(/(?<=[\.!?…」”’\)]+)\s+/g)
    .map((s) => s.trim())
    .filter(Boolean);
}
function splitEnglishSentences(text: string): string[] {
  const normalized = normalizeWhitespace(text);
  return normalized
    .split(/(?<=[.!?])\s+(?=[A-Z"“‘(])/g)
    .flatMap((s) => s.split(/(?<=\.)\s+(?=\")/g))
    .map((s) => s.trim())
    .filter(Boolean);
}
export function splitSentencesByLang(text: string, lang: string): string[] {
  if (lang.toLowerCase().startsWith("ko")) return splitKoreanSentences(text);
  if (lang.toLowerCase().startsWith("en")) return splitEnglishSentences(text);
  return normalizeWhitespace(text)
    .split(/(?<=[.!?])\s+|\n{2,}/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------- 간단 정렬 ----------
export type AlignedPair = {
  kr?: string;
  en?: string;
  kr_id?: number;
  en_id?: number;
};
export function alignGreedy(koSent: string[], enSent: string[]): AlignedPair[] {
  const n = Math.max(koSent.length, enSent.length);
  const pairs: AlignedPair[] = [];
  for (let i = 0; i < n; i++) {
    pairs.push({
      kr: koSent[i],
      en: enSent[i],
      kr_id: typeof koSent[i] === "string" ? i : undefined,
      en_id: typeof enSent[i] === "string" ? i : undefined,
    });
  }
  return pairs;
}
export function alignSimple(koSent: string[], enSent: string[]): AlignedPair[] {
  return alignGreedy(koSent, enSent);
}
export async function alignBySpecAsync(
  spec: Spec,
  koSent: string[],
  enSent: string[],
) {
  const mode = spec.runtime?.aligner ?? "greedy";
  if (mode === "embeddings") {
    const { K, E } = await getEmbeddingsForLists(koSent, enSent, {
      batchSize: 64,
    });
    return alignByEmbeddingsDP(koSent, enSent, K, E, { gapPenalty: -0.15 });
  }
  if (mode === "simple") return alignSimple(koSent, enSent);
  return alignGreedy(koSent, enSent);
}

// ---------- 버킷 ----------
export function makeBucketsFromSpec(spec: Spec): ResultBucket[] {
  const buckets: ResultBucket[] = [];
  for (const group of spec.groups) {
    for (const sf of group.subfeatures) {
      buckets.push({
        group: group.name,
        subfeatureKey: sf.key,
        subfeatureLabel: sf.label,
        items: [],
      });
    }
  }
  return buckets;
}
export function pushItems(
  buckets: ResultBucket[],
  groupName: string,
  subKey: string,
  subLabel: string,
  items: IssueItem[],
) {
  let b = buckets.find(
    (v) => v.group === groupName && v.subfeatureKey === subKey,
  );
  if (!b) {
    b = {
      group: groupName,
      subfeatureKey: subKey,
      subfeatureLabel: subLabel,
      items: [],
    };
    buckets.push(b);
  }
  b.items.push(...items);
}
export function countBySubfeature(
  buckets: ResultBucket[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of buckets)
    out[b.subfeatureLabel] = (out[b.subfeatureLabel] || 0) + b.items.length;
  return out;
}

// ---------- 리포트 메타 ----------
export function buildReportMeta(params: {
  sourcePath: string;
  targetPath: string;
  sourceLang: string;
  targetLang: string;
  alignment: "sentence" | "paragraph";
}) {
  return {
    schemaVersion: "1.0" as const,
    source: { lang: params.sourceLang, path: params.sourcePath },
    target: { lang: params.targetLang, path: params.targetPath },
    alignment: params.alignment,
    generatedAt: new Date().toISOString(),
  };
}

// ---------- 긴 텍스트 조각내기(옵션) ----------
export function chunkBySize(text: string, maxChars = 2000): string[] {
  const s = normalizeWhitespace(text);
  if (s.length <= maxChars) return [s];
  const chunks: string[] = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(i + maxChars, s.length);
    const window = s.slice(i, end);
    const lastBoundary = Math.max(
      window.lastIndexOf("\n"),
      window.lastIndexOf(". "),
      window.lastIndexOf("! "),
      window.lastIndexOf("? "),
      window.lastIndexOf("… "),
      window.lastIndexOf("。"),
      window.lastIndexOf("！"),
      window.lastIndexOf("？"),
    );
    if (lastBoundary > 100) end = i + lastBoundary + 1;
    chunks.push(s.slice(i, end).trim());
    i = end;
  }
  return chunks.filter(Boolean);
}
