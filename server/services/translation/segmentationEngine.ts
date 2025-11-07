import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import path from "node:path";

import { pool, query } from "../../db";
import {
  getTranslationSegmentationMode,
  type SegmentationMode,
} from "../../config/appControlConfiguration";
import {
  calculateTokenBudget,
  type TokenBudgetMode,
} from "./tokenBudget";

const OVERLAP_MIN = 40;
const OVERLAP_MAX = 60;
const DEFAULT_OVERLAP = 50;
const SENTENCE_MAX_MIN = 200;
const SENTENCE_MAX_MAX = 800;
const DEFAULT_SENTENCE_MAX = 480;
const SEGMENT_GROUP_MULTIPLIER = 3;

const MIN_SEGMENT_YIELD_INTERVAL = 10;
const MAX_SEGMENT_YIELD_INTERVAL = 500;
const DEFAULT_SEGMENT_YIELD_INTERVAL = 75;
const DEFAULT_PERSIST_YIELD_EVERY = 1;

const parseNumber = (value: string | undefined): number => {
  if (!value) return Number.NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

const clampYieldInterval = (raw: number): number => {
  if (!Number.isFinite(raw) || raw <= 0) {
    return Number.MAX_SAFE_INTEGER;
  }
  const clamped = Math.min(
    Math.max(Math.floor(raw), MIN_SEGMENT_YIELD_INTERVAL),
    MAX_SEGMENT_YIELD_INTERVAL,
  );
  return clamped;
};

const SEGMENT_BUILD_YIELD_INTERVAL = clampYieldInterval(
  parseNumber(process.env.CANONICAL_SEGMENT_YIELD_INTERVAL) ||
    DEFAULT_SEGMENT_YIELD_INTERVAL,
);

const resolvePersistYieldEvery = (raw: number): number => {
  if (!Number.isFinite(raw) || raw <= 0) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.max(1, Math.floor(raw));
};

const PERSIST_CHUNK_YIELD_INTERVAL = resolvePersistYieldEvery(
  parseNumber(process.env.CANONICAL_PERSIST_YIELD_EVERY) ||
    DEFAULT_PERSIST_YIELD_EVERY,
);

const SEGMENT_WORKER_ENABLED =
  (process.env.CANONICAL_SEGMENT_WORKER ?? "true").toLowerCase() !== "false";

const workerScriptJs = path.resolve(__dirname, "segmentationWorker.js");
const workerScriptTs = path.resolve(__dirname, "segmentationWorker.ts");
const useTsWorker = Boolean(
  process.env.TS_NODE_DEV || process.env.TS_NODE_PROJECT || process.env.TS_NODE,
);

const createSegmentationWorker = () =>
  new Worker(useTsWorker ? workerScriptTs : workerScriptJs, {
    execArgv: useTsWorker ? ["-r", "ts-node/register"] : undefined,
  });

const SEGMENT_WORKER_TIMEOUT_MS = Number(
  process.env.CANONICAL_SEGMENT_WORKER_TIMEOUT_MS ?? 120_000,
);

const runSegmentationInWorker = async (
  options: CanonicalSegmentationOptions & { runId: string },
): Promise<CanonicalSegmentationResult> =>
  new Promise((resolve, reject) => {
    if (!SEGMENT_WORKER_ENABLED) {
      segmentCanonicalText(options).then(resolve).catch(reject);
      return;
    }

    const worker = createSegmentationWorker();
    const id = `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
    let settled = false;

    const cleanup = () => {
      worker.removeAllListeners("message");
      worker.removeAllListeners("error");
      worker.terminate().catch(() => {
        /* ignore */
      });
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("segmentation_worker_timeout"));
    }, SEGMENT_WORKER_TIMEOUT_MS);

    worker.on("message", (
      message: {
        id: string;
        result?: CanonicalSegmentationResult;
        error?: string;
      },
    ) => {
      if (message.id !== id || settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      if (message.error) {
        reject(new Error(message.error));
        return;
      }
      resolve(message.result as CanonicalSegmentationResult);
    });

    worker.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(error);
    });

    worker.postMessage({ id, options });
  });

let segmentMetaSchemaEnsured = false;
const ensureSegmentMetaSchema = async (): Promise<void> => {
  if (segmentMetaSchemaEnsured) return;
  await query(
    `ALTER TABLE IF EXISTS translation_segment_meta
      ADD COLUMN IF NOT EXISTS sentence_index INT`,
  );
  segmentMetaSchemaEnsured = true;
};

const yieldToEventLoop = async (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

const createYieldController = (threshold: number) => {
  const disabled = threshold === Number.MAX_SAFE_INTEGER;
  const limit = disabled ? Number.MAX_SAFE_INTEGER : threshold;
  let counter = 0;
  return {
    async tick(increment = 1): Promise<void> {
      if (disabled) return;
      counter += increment;
      if (counter >= limit) {
        counter = 0;
        await yieldToEventLoop();
      }
    },
    async flush(): Promise<void> {
      if (disabled || counter === 0) {
        counter = 0;
        return;
      }
      counter = 0;
      await yieldToEventLoop();
    },
  };
};

const parsedOverlap = Number.parseInt(
  process.env.SEGMENTATION_OVERLAP_TOKENS ?? "",
  10,
);

const OVERLAP_TOKENS = Number.isFinite(parsedOverlap)
  ? Math.min(Math.max(parsedOverlap, OVERLAP_MIN), OVERLAP_MAX)
  : DEFAULT_OVERLAP;

const parsedSentenceMax = Number.parseInt(
  process.env.SEGMENTATION_SENTENCE_MAX_TOKENS ?? "",
  10,
);

const SENTENCE_MAX_TOKENS = Number.isFinite(parsedSentenceMax)
  ? Math.min(
      Math.max(parsedSentenceMax, SENTENCE_MAX_MIN),
      SENTENCE_MAX_MAX,
    )
  : DEFAULT_SENTENCE_MAX;

const SEGMENT_TOKEN_LIMIT = SENTENCE_MAX_TOKENS * SEGMENT_GROUP_MULTIPLIER;

interface ParagraphInfo {
  text: string;
  start: number;
  end: number;
  index: number;
}

interface SentenceInfo {
  text: string;
  start: number;
  end: number;
  tokens: number;
  index: number;
}

export interface CanonicalSegment {
  id: string;
  hash: string;
  segmentOrder: number;
  paragraphIndex: number;
  sentenceIndex: number | null;
  startOffset: number;
  endOffset: number;
  overlapPrev: boolean;
  overlapNext: boolean;
  overlapTokens: number;
  tokenEstimate: number;
  tokenBudget: number;
  text: string;
}

export interface CanonicalSegmentationResult {
  mode: SegmentationMode;
  sourceHash: string;
  segments: CanonicalSegment[];
}

export interface CanonicalSegmentationOptions {
  text: string;
  projectId?: string;
  modeOverride?: SegmentationMode;
  sourceLanguage?: string | null;
  targetLanguage?: string | null;
}

let blake3Promise:
  | Promise<(input: string | Uint8Array) => string>
  | null = null;

async function loadHashFunction(): Promise<
  (input: string | Uint8Array) => string
> {
  if (!blake3Promise) {
    blake3Promise = (async () => {
      try {
        const mod = await import("hash-wasm");
        const instance = await mod.createBLAKE3();
        return (input: string | Uint8Array) => {
          instance.init();
          instance.update(input);
          return instance.digest("hex");
        };
      } catch (error) {
        console.warn(
          "[segmentation] Failed to load hash-wasm, falling back to sha256",
          error,
        );
        return (input: string | Uint8Array) =>
          createHash("sha256")
            .update(typeof input === "string" ? input : Buffer.from(input))
            .digest("hex");
      }
    })();
  }
  return blake3Promise;
}

function normalizeWhitespace(input: string): string {
  return input
    .replace(/\r\n/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[\t\f\v]/g, " ")
    .replace(/ +/g, " ");
}

function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed.length) return 0;
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

function extractParagraphs(normalized: string): ParagraphInfo[] {
  const paragraphs: ParagraphInfo[] = [];
  const regex = /(.*?)(?:\n{2,}|$)/gs;
  let match: RegExpExecArray | null;
  let paragraphIndex = 0;
  while ((match = regex.exec(normalized))) {
    const block = match[1] ?? "";
    const leading = block.search(/\S/);
    const trimmedStart = leading === -1 ? block.length : leading;
    const trimmedEnd = block.replace(/\s+$/g, "").length;
    const text = block.slice(trimmedStart, trimmedEnd);
    if (!text.trim()) {
      continue;
    }
    const start = (match.index ?? 0) + trimmedStart;
    const end = (match.index ?? 0) + trimmedEnd;
    paragraphs.push({ text, start, end, index: paragraphIndex });
    paragraphIndex += 1;
  }
  return paragraphs;
}

const HANGUL_REGEX = /[\uac00-\ud7a3]/;
const LATIN_REGEX = /[A-Za-z]/;

function detectLanguageHint(
  paragraph: string,
  defaultLang: "ko" | "en",
): "ko" | "en" {
  let hangul = 0;
  let latin = 0;
  for (const char of paragraph) {
    if (HANGUL_REGEX.test(char)) {
      hangul += 1;
    } else if (LATIN_REGEX.test(char)) {
      latin += 1;
    }
  }

  const total = paragraph.length || 1;
  const hangulRatio = hangul / total;
  const latinRatio = latin / total;

  if (hangulRatio >= 0.6) return "ko";
  if (latinRatio >= 0.6) return "en";
  return defaultLang;
}

function resolveDefaultLanguage(
  sourceLanguage?: string | null,
  targetLanguage?: string | null,
): "ko" | "en" {
  const source = (sourceLanguage ?? "").toLowerCase();
  if (source.startsWith("ko")) return "ko";
  if (source.startsWith("en")) return "en";
  const target = (targetLanguage ?? "").toLowerCase();
  if (target.startsWith("ko")) return "en";
  if (target.startsWith("en")) return "ko";
  return "en";
}

function normalizeLang(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed.startsWith("ko")) return "ko";
  if (trimmed.startsWith("en")) return "en";
  return trimmed.slice(0, 2);
}

function buildDirection(
  sourceLanguage?: string | null,
  targetLanguage?: string | null,
): string | null {
  const source = normalizeLang(sourceLanguage);
  const target = normalizeLang(targetLanguage);
  if (!source || !target) {
    return null;
  }
  return `${source}-${target}`;
}

function resolveBudgetMode(stage: string): TokenBudgetMode {
  if (stage === "draft" || stage === "revise" || stage === "micro-check") {
    return stage;
  }
  return "other";
}

function fallbackSplitSentences(text: string): string[] {
  const pattern =
    /[^.!?…\u203D\u203C\u3002\uFF01\uFF1F]+(?:[.!?…\u203D\u203C\u3002\uFF01\uFF1F]+|$)/g;
  const matches = text.match(pattern);
  if (!matches) {
    const trimmed = text.trim();
    return trimmed ? [trimmed] : [];
  }
  return matches.map((value) => value.trim()).filter((value) => value.length > 0);
}

async function getSentenceStrings(
  paragraphText: string,
  lang: "ko" | "en",
): Promise<string[]> {
  if (typeof (Intl as any).Segmenter === "function") {
    try {
      const segmenter = new (Intl as any).Segmenter(lang, {
        granularity: "sentence",
      });
      const sentences: string[] = [];
      for (const segment of segmenter.segment(paragraphText)) {
        const trimmed = segment.segment.trim();
        if (trimmed.length) {
          sentences.push(trimmed);
        }
      }
      if (sentences.length) {
        return sentences;
      }
    } catch (error) {
      console.warn(
        `[segmentation] Intl.Segmenter failed for ${lang}, falling back`,
        error,
      );
    }
  }
  return fallbackSplitSentences(paragraphText);
}

async function buildSentenceInfos(
  paragraph: ParagraphInfo,
  normalized: string,
  langHint: "ko" | "en",
): Promise<SentenceInfo[]> {
  const sentenceStrings = await getSentenceStrings(paragraph.text, langHint);
  if (!sentenceStrings.length) {
    const tokens = estimateTokens(paragraph.text);
    return [
      {
        text: normalized.slice(paragraph.start, paragraph.end),
        start: paragraph.start,
        end: paragraph.end,
        tokens,
        index: 0,
      },
    ];
  }

  const results: SentenceInfo[] = [];
  let localCursor = 0;
  let sentenceIndex = 0;

  for (const rawSentence of sentenceStrings) {
    const trimmed = rawSentence.trim();
    if (!trimmed.length) continue;

    let relativeIndex = paragraph.text.indexOf(trimmed, localCursor);
    if (relativeIndex === -1) {
      relativeIndex = paragraph.text.indexOf(trimmed);
    }
    if (relativeIndex === -1) {
      relativeIndex = localCursor;
    }

    const start = paragraph.start + relativeIndex;
    const end = start + trimmed.length;
    const text = normalized.slice(start, end);

    results.push({
      text,
      start,
      end,
      tokens: estimateTokens(text),
      index: sentenceIndex,
    });

    localCursor = relativeIndex + trimmed.length;
    sentenceIndex += 1;
  }

  if (!results.length) {
    const tokens = estimateTokens(paragraph.text);
    return [
      {
        text: normalized.slice(paragraph.start, paragraph.end),
        start: paragraph.start,
        end: paragraph.end,
        tokens,
        index: 0,
      },
    ];
  }

  return results;
}

function splitSentenceByLength(sentence: SentenceInfo): SentenceInfo[] {
  if (sentence.tokens <= SENTENCE_MAX_TOKENS) {
    return [sentence];
  }

  const text = sentence.text;
  const maxChars = SENTENCE_MAX_TOKENS * 4;
  const chunks: SentenceInfo[] = [];
  let offset = 0;
  while (offset < text.length) {
    let tentativeEnd = Math.min(text.length, offset + maxChars);
    if (tentativeEnd < text.length) {
      const boundary = text.lastIndexOf(" ", tentativeEnd);
      if (boundary > offset + 10) {
        tentativeEnd = boundary;
      }
    }
    if (tentativeEnd <= offset) {
      tentativeEnd = Math.min(text.length, offset + maxChars);
    }

    const chunkSource = text.slice(offset, tentativeEnd);
    const chunkTrimmed = chunkSource.trim();
    if (!chunkTrimmed.length) {
      offset = tentativeEnd + 1;
      continue;
    }

    const relativeIndex = text.indexOf(chunkTrimmed, offset);
    const start = sentence.start + relativeIndex;
    const end = start + chunkTrimmed.length;

    chunks.push({
      text: chunkTrimmed,
      start,
      end,
      tokens: estimateTokens(chunkTrimmed),
      index: sentence.index,
    });

    offset = relativeIndex + chunkTrimmed.length;
  }

  return chunks.length ? chunks : [sentence];
}

function groupSentencesIntoSegments(
  paragraph: ParagraphInfo,
  sentences: SentenceInfo[],
): Array<{ start: number; end: number; tokens: number; firstSentenceIndex: number | null }> {
  if (!sentences.length) {
    return [
      {
        start: paragraph.start,
        end: paragraph.end,
        tokens: estimateTokens(paragraph.text),
        firstSentenceIndex: null,
      },
    ];
  }

  const groups: Array<{
    start: number;
    end: number;
    tokens: number;
    firstSentenceIndex: number | null;
  }> = [];

  let currentStart = sentences[0].start;
  let currentEnd = sentences[0].end;
  let currentTokens = sentences[0].tokens;
  let firstSentenceIndex: number | null = sentences[0].index;

  for (let i = 1; i < sentences.length; i += 1) {
    const sentence = sentences[i];
    if (currentTokens + sentence.tokens > SEGMENT_TOKEN_LIMIT && currentTokens > 0) {
      groups.push({
        start: currentStart,
        end: currentEnd,
        tokens: currentTokens,
        firstSentenceIndex,
      });
      currentStart = sentence.start;
      currentTokens = sentence.tokens;
      firstSentenceIndex = sentence.index;
    } else {
      currentTokens += sentence.tokens;
    }
    currentEnd = sentence.end;
  }

  groups.push({
    start: currentStart,
    end: currentEnd,
    tokens: currentTokens,
    firstSentenceIndex,
  });

  return groups;
}

function formatSegmentId(order: number): string {
  return `seg-${String(order + 1).padStart(4, "0")}`;
}

export async function segmentCanonicalText(
  options: CanonicalSegmentationOptions,
): Promise<CanonicalSegmentationResult> {
  const normalized = normalizeWhitespace(options.text ?? "");
  if (!normalized.trim()) {
    throw new Error("No text provided for segmentation");
  }

  const mode = options.modeOverride ?? getTranslationSegmentationMode();
  const defaultLang = resolveDefaultLanguage(
    options.sourceLanguage,
    options.targetLanguage,
  );
  const paragraphs = extractParagraphs(normalized);
  if (!paragraphs.length) {
    throw new Error("Segmentation produced no segments");
  }

  const hashFn = await loadHashFunction();
  const segments: CanonicalSegment[] = [];
  let segmentOrder = 0;
  const direction = buildDirection(options.sourceLanguage, options.targetLanguage);
  const yieldController = createYieldController(SEGMENT_BUILD_YIELD_INTERVAL);

  for (const paragraph of paragraphs) {
    const langHint = detectLanguageHint(paragraph.text, defaultLang);
    const sentenceInfos = await buildSentenceInfos(paragraph, normalized, langHint);

    if (mode === "sentence") {
      for (const sentence of sentenceInfos) {
        const chunks = splitSentenceByLength(sentence);
        for (const chunk of chunks) {
          const text = normalized.slice(chunk.start, chunk.end);
          const tokenEstimate = estimateTokens(text);
          const hash = hashFn(text);
          const baseSegment: CanonicalSegment = {
            id: formatSegmentId(segmentOrder),
            hash,
            segmentOrder,
            paragraphIndex: paragraph.index,
            sentenceIndex: chunk.index,
            startOffset: chunk.start,
            endOffset: chunk.end,
            overlapPrev: false,
            overlapNext: false,
            overlapTokens: 0,
            tokenEstimate,
            tokenBudget: 0,
            text,
          } satisfies CanonicalSegment;
          baseSegment.tokenBudget = calculateTokenBudget({
            originSegments: [baseSegment],
            mode: resolveBudgetMode("draft"),
            direction,
          }).tokensInCap;
          segments.push(baseSegment);
          segmentOrder += 1;
          await yieldController.tick();
        }
      }
      continue;
    }

    const groups = groupSentencesIntoSegments(paragraph, sentenceInfos);
    for (const group of groups) {
      const text = normalized.slice(group.start, group.end);
      const tokenEstimate = estimateTokens(text);
      const hash = hashFn(text);
      const baseSegment: CanonicalSegment = {
        id: formatSegmentId(segmentOrder),
        hash,
        segmentOrder,
        paragraphIndex: paragraph.index,
        sentenceIndex: group.firstSentenceIndex,
        startOffset: group.start,
        endOffset: group.end,
        overlapPrev: false,
        overlapNext: false,
        overlapTokens: 0,
        tokenEstimate,
        tokenBudget: 0,
        text,
      } satisfies CanonicalSegment;
      baseSegment.tokenBudget = calculateTokenBudget({
        originSegments: [baseSegment],
        mode: resolveBudgetMode("draft"),
        direction,
      }).tokensInCap;
      segments.push(baseSegment);
      segmentOrder += 1;
      await yieldController.tick();
    }
  }

  if (!segments.length) {
    throw new Error("Segmentation produced no segments");
  }

  if (mode === "paragraph") {
    segments.forEach((segment, index) => {
      segment.overlapPrev = index > 0;
      segment.overlapNext = index < segments.length - 1;
      segment.overlapTokens = segment.overlapNext
        ? Math.min(OVERLAP_TOKENS, segment.tokenEstimate)
        : 0;
    });
  }

  const sourceHash = hashFn(normalized);
  await yieldController.flush();

  return {
    mode,
    sourceHash,
    segments,
  };
}

type SegmentRow = {
  segment_id: string;
  hash: string;
  segment_order: number;
  paragraph_index: number;
  sentence_index: number | null;
  start_offset: number;
  end_offset: number;
  overlap_prev: boolean | string;
  overlap_next: boolean | string;
  overlap_tokens: number;
  token_estimate: number;
  token_budget: number;
};

function toBoolean(value: unknown): boolean {
  return value === true || value === "t" || value === "1" || value === 1;
}

function buildSegmentsFromRows(
  rows: SegmentRow[],
  normalized: string,
): CanonicalSegment[] {
  return rows
    .map((row) => {
      const start = Number(row.start_offset);
      const end = Number(row.end_offset);
      const text = normalized.slice(start, end);
      return {
        id: row.segment_id,
        hash: row.hash,
        segmentOrder: Number(row.segment_order),
        paragraphIndex: Number(row.paragraph_index),
        sentenceIndex:
          row.sentence_index === null || row.sentence_index === undefined
            ? null
            : Number(row.sentence_index),
        startOffset: start,
        endOffset: end,
        overlapPrev: toBoolean(row.overlap_prev),
        overlapNext: toBoolean(row.overlap_next),
        overlapTokens: Number(row.overlap_tokens),
        tokenEstimate: Number(row.token_estimate),
        tokenBudget: Number(row.token_budget),
        text,
      } satisfies CanonicalSegment;
    })
    .sort((a, b) => a.segmentOrder - b.segmentOrder);
}

async function fetchSegmentRows(runId: string): Promise<SegmentRow[]> {
  const { rows } = await query(
    `SELECT segment_id,
            hash,
            segment_order,
            paragraph_index,
            sentence_index,
            start_offset,
            end_offset,
            overlap_prev,
            overlap_next,
            overlap_tokens,
            token_estimate,
            token_budget
       FROM translation_segment_meta
      WHERE run_id = $1
      ORDER BY segment_order ASC`,
    [runId],
  );
  return rows as SegmentRow[];
}

async function deleteExistingSegments(runId: string): Promise<void> {
  await query(`DELETE FROM translation_segment_meta WHERE run_id = $1`, [runId]);
}

const SEGMENT_INSERT_COLUMNS = `(
    run_id,
    segment_id,
    hash,
    segment_order,
    paragraph_index,
    sentence_index,
    start_offset,
    end_offset,
    overlap_prev,
    overlap_next,
    overlap_tokens,
    token_estimate,
    token_budget
  )`;

async function persistSegments(
  runId: string,
  segments: CanonicalSegment[],
): Promise<void> {
  const startedAt = Date.now();
  const parsedChunkSize = Number(process.env.CANONICAL_SEGMENT_BATCH_SIZE ?? 200);
  const chunkSize = Number.isFinite(parsedChunkSize) && parsedChunkSize > 0
    ? Math.min(Math.floor(parsedChunkSize), 500)
    : 200;
  console.info("[segmentation] Persisting canonical segments", {
    runId,
    segmentCount: segments.length,
    chunkSize,
  });
  const client = await pool.connect();
  let chunksExecuted = 0;
  let chunksSinceYield = 0;
  try {
    await ensureSegmentMetaSchema();
    await client.query("BEGIN");
    for (let index = 0; index < segments.length; index += chunkSize) {
      const chunk = segments.slice(index, index + chunkSize);
      if (!chunk.length) continue;
      const values: string[] = [];
      const params: unknown[] = [];
      chunk.forEach((segment, chunkIndex) => {
        const tokenBudget = Number.isFinite(segment.tokenBudget)
          ? Math.max(1, Math.floor(segment.tokenBudget))
          : Math.max(1, Math.floor(segment.tokenEstimate));
        const offset = chunkIndex * 13;
        values.push(
          `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9},$${offset + 10},$${offset + 11},$${offset + 12},$${offset + 13})`,
        );
        params.push(
          runId,
          segment.id,
          segment.hash,
          segment.segmentOrder,
          segment.paragraphIndex,
          segment.sentenceIndex,
          segment.startOffset,
          segment.endOffset,
          segment.overlapPrev,
          segment.overlapNext,
          segment.overlapTokens,
          segment.tokenEstimate,
          tokenBudget,
        );
      });

      const sql = `INSERT INTO translation_segment_meta ${SEGMENT_INSERT_COLUMNS} VALUES ${values.join(",")}`;
      await client.query(sql, params);
      chunksExecuted += 1;
      if (PERSIST_CHUNK_YIELD_INTERVAL !== Number.MAX_SAFE_INTEGER) {
        chunksSinceYield += 1;
        if (chunksSinceYield >= PERSIST_CHUNK_YIELD_INTERVAL) {
          chunksSinceYield = 0;
          await yieldToEventLoop();
        }
      }
    }
    await client.query("COMMIT");
    const durationMs = Date.now() - startedAt;
    console.info("[segmentation] canonical segments persisted", {
      runId,
      segmentCount: segments.length,
      chunksExecuted,
      durationMs,
    });
  } catch (error) {
    console.error("[segmentation] Failed to persist segments", {
      runId,
      segmentCount: segments.length,
      err: error,
    });
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("[segmentation] Failed to rollback segment persistence", {
        runId,
        err: rollbackError,
      });
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function ensureCanonicalSegments(
  options: CanonicalSegmentationOptions & { runId: string },
): Promise<CanonicalSegmentationResult> {
  const normalized = normalizeWhitespace(options.text ?? "");
  const mode = options.modeOverride ?? getTranslationSegmentationMode();
  const hashFn = await loadHashFunction();
  const sourceHash = hashFn(normalized);

  let rows = await fetchSegmentRows(options.runId);
  if (rows.length) {
    const segmentsFromDb = buildSegmentsFromRows(rows, normalized);
    const hashesMatch = segmentsFromDb.every(
      (segment) => hashFn(segment.text) === segment.hash,
    );
    if (hashesMatch) {
      return {
        mode,
        sourceHash,
        segments: segmentsFromDb,
      };
    }
    await deleteExistingSegments(options.runId);
    rows = [];
  }

  if (!rows.length) {
    const canonical = await runSegmentationInWorker(options);
    await persistSegments(options.runId, canonical.segments);
    return canonical;
  }

  // Fallback, though code should not reach here
  return {
    mode,
    sourceHash,
    segments: buildSegmentsFromRows(rows, normalized),
  };
}

export async function loadCanonicalSegments(options: {
  runId: string;
  originText: string;
  modeOverride?: SegmentationMode;
}): Promise<CanonicalSegmentationResult | null> {
  const rows = await fetchSegmentRows(options.runId);
  if (!rows.length) {
    return null;
  }
  const normalized = normalizeWhitespace(options.originText ?? "");
  const hashFn = await loadHashFunction();
  return {
    mode: options.modeOverride ?? getTranslationSegmentationMode(),
    sourceHash: hashFn(normalized),
    segments: buildSegmentsFromRows(rows, normalized),
  };
}
