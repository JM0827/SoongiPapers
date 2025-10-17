import OpenAI from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";

export type EmbeddingAlignOptions = {
  gapPenalty?: number;
  normalize?: boolean;
  batchSize?: number;
};
export type AlignedPair = {
  kr?: string;
  en?: string;
  kr_id?: number;
  en_id?: number;
};

function l2norm(v: number[]) {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}
function normalize(v: number[]) {
  const n = l2norm(v) || 1;
  return v.map((x) => x / n);
}
function cosine(a: number[], b: number[]) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: texts,
  });
  return res.data.map((d) => d.embedding as number[]);
}

export async function getEmbeddingsForLists(
  ko: string[],
  en: string[],
  opt: EmbeddingAlignOptions = {},
) {
  const batch = opt.batchSize ?? 64;
  const K: number[][] = [],
    E: number[][] = [];
  for (let i = 0; i < ko.length; i += batch)
    K.push(...(await embedBatch(ko.slice(i, i + batch))));
  for (let j = 0; j < en.length; j += batch)
    E.push(...(await embedBatch(en.slice(j, j + batch))));
  const useNorm = opt.normalize ?? true;
  return {
    K: useNorm ? K.map(normalize) : K,
    E: useNorm ? E.map(normalize) : E,
  };
}

export function alignByEmbeddingsDP(
  ko: string[],
  en: string[],
  K: number[][],
  E: number[][],
  opt: EmbeddingAlignOptions = {},
): AlignedPair[] {
  const gap = opt.gapPenalty ?? -0.15;
  const n = ko.length,
    m = en.length;
  const S: number[][] = Array.from({ length: n }, () => Array(m).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++)
      S[i][j] = Math.max(-1, Math.min(1, cosine(K[i], E[j])));

  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    Array(m + 1).fill(0),
  );
  const bt: ("diag" | "up" | "left" | null)[][] = Array.from(
    { length: n + 1 },
    () => Array(m + 1).fill(null),
  );
  for (let i = 1; i <= n; i++) {
    dp[i][0] = dp[i - 1][0] + gap;
    bt[i][0] = "up";
  }
  for (let j = 1; j <= m; j++) {
    dp[0][j] = dp[0][j - 1] + gap;
    bt[0][j] = "left";
  }

  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) {
      const d = dp[i - 1][j - 1] + S[i - 1][j - 1];
      const u = dp[i - 1][j] + gap;
      const l = dp[i][j - 1] + gap;
      if (d >= u && d >= l) {
        dp[i][j] = d;
        bt[i][j] = "diag";
      } else if (u >= l) {
        dp[i][j] = u;
        bt[i][j] = "up";
      } else {
        dp[i][j] = l;
        bt[i][j] = "left";
      }
    }

  const pairs: AlignedPair[] = [];
  let i = n,
    j = m;
  while (i > 0 || j > 0) {
    const b = bt[i][j];
    if (b === "diag") {
      pairs.push({ kr: ko[i - 1], en: en[j - 1], kr_id: i - 1, en_id: j - 1 });
      i--;
      j--;
    } else if (b === "up") {
      pairs.push({
        kr: ko[i - 1],
        en: undefined,
        kr_id: i - 1,
        en_id: undefined,
      });
      i--;
    } else if (b === "left") {
      pairs.push({
        kr: undefined,
        en: en[j - 1],
        kr_id: undefined,
        en_id: j - 1,
      });
      j--;
    } else break;
  }
  pairs.reverse();
  return pairs;
}
