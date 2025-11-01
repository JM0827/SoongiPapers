import { createHash } from "node:crypto";
import {
  getTranslationSegmentationMode,
  type SegmentationMode,
} from "../../config/appControlConfiguration";

export interface OriginSegment {
  id: string;
  index: number;
  text: string;
  paragraphIndex: number;
  sentenceIndex: number | null;
}

export interface SegmentationResult {
  mode: SegmentationMode;
  sourceHash: string;
  segments: OriginSegment[];
}

export interface SegmentationAgentOptions {
  text: string;
  projectId: string;
  modeOverride?: SegmentationMode;
  maxSegmentLength?: number;
}

const parsedMaxSegmentLength = Number.parseInt(
  process.env.SEGMENTATION_MAX_SEGMENT_LENGTH_V2 ?? "",
  10,
);

const DEFAULT_MAX_SEGMENT_LENGTH =
  Number.isFinite(parsedMaxSegmentLength) && parsedMaxSegmentLength > 0
    ? parsedMaxSegmentLength
    : 1600;

const sentenceRegex =
  /[^.!?\u203D\u203C\u3002\uFF01\uFF1F]+(?:[.!?\u203D\u203C\u3002\uFF01\uFF1F]+|$)/gu;

function normalizeWhitespace(input: string): string {
  return input
    .replace(/\r\n/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[\t\f\v]/g, " ")
    .replace(/ +/g, " ");
}

function trimSegment(input: string): string {
  return input
    .replace(/\s+$/g, "")
    .replace(/^\s+/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/g)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

function splitSentences(paragraph: string): string[] {
  const matches = paragraph.match(sentenceRegex);
  if (!matches) {
    return [paragraph.trim()].filter(Boolean);
  }
  return matches
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function chunkLongText(
  text: string,
  maxLength: number,
  paragraphIndex: number,
  startIndex: number,
): OriginSegment[] {
  const segments: OriginSegment[] = [];
  let remaining = text;
  let offset = 0;
  while (remaining.length > maxLength) {
    const slice = remaining.slice(0, maxLength);
    const lastBoundary = Math.max(
      slice.lastIndexOf(". "),
      slice.lastIndexOf(".\n"),
      slice.lastIndexOf("\n\n"),
      slice.lastIndexOf("? "),
      slice.lastIndexOf("! "),
    );
    const pivot = lastBoundary > maxLength * 0.4 ? lastBoundary + 1 : maxLength;
    const chunk = trimSegment(remaining.slice(0, pivot));
    segments.push({
      id: `seg-${String(startIndex + segments.length + 1).padStart(4, "0")}`,
      index: startIndex + segments.length,
      text: chunk,
      paragraphIndex,
      sentenceIndex: null,
    });
    remaining = remaining.slice(pivot).trimStart();
    offset += pivot;
  }
  if (remaining.length) {
    segments.push({
      id: `seg-${String(startIndex + segments.length + 1).padStart(4, "0")}`,
      index: startIndex + segments.length,
      text: trimSegment(remaining),
      paragraphIndex,
      sentenceIndex: null,
    });
  }
  return segments;
}

export function segmentOriginText(
  options: SegmentationAgentOptions,
): SegmentationResult {
  if (!options.text.trim()) {
    throw new Error("No text provided for segmentation");
  }

  const mode = options.modeOverride ?? getTranslationSegmentationMode();
  const maxLength = options.maxSegmentLength ?? DEFAULT_MAX_SEGMENT_LENGTH;
  const normalized = normalizeWhitespace(options.text);
  const paragraphs = splitParagraphs(normalized);

  const segments: OriginSegment[] = [];
  let globalIndex = 0;

  paragraphs.forEach((paragraph, paragraphIndex) => {
    if (!paragraph.trim()) return;

    if (mode === "sentence") {
      const sentences = splitSentences(paragraph);
      sentences.forEach((sentence, sentenceIndex) => {
        if (!sentence.trim()) return;
        if (sentence.length > maxLength) {
          const chunks = chunkLongText(
            sentence,
            maxLength,
            paragraphIndex,
            globalIndex,
          );
          chunks.forEach((chunk) => {
            segments.push({
              ...chunk,
              sentenceIndex,
            });
          });
          globalIndex += chunks.length;
        } else {
          segments.push({
            id: `seg-${String(globalIndex + 1).padStart(4, "0")}`,
            index: globalIndex,
            text: trimSegment(sentence),
            paragraphIndex,
            sentenceIndex,
          });
          globalIndex += 1;
        }
      });
    } else if (paragraph.length > maxLength) {
      const chunks = chunkLongText(
        paragraph,
        maxLength,
        paragraphIndex,
        globalIndex,
      );
      chunks.forEach((chunk) => segments.push(chunk));
      globalIndex += chunks.length;
    } else {
      segments.push({
        id: `seg-${String(globalIndex + 1).padStart(4, "0")}`,
        index: globalIndex,
        text: trimSegment(paragraph),
        paragraphIndex,
        sentenceIndex: null,
      });
      globalIndex += 1;
    }
  });

  if (!segments.length) {
    throw new Error("Segmentation produced no segments");
  }

  const sourceHash = createHash("sha256").update(normalized).digest("hex");

  return {
    mode,
    sourceHash,
    segments,
  };
}
