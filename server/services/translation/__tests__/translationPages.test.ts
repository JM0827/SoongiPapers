import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { OriginSegment } from "../../../agents/translation";
import type { CanonicalSegment } from "../../translation/segmentationEngine";
import {
  buildTranslationPages,
  parseTranslationCursor,
  serializeTranslationCursor,
  type TranslationSegmentText,
} from "../../translation/translationPages";

const buildSegments = (count: number): {
  originSegments: OriginSegment[];
  segmentTexts: TranslationSegmentText[];
  mergedText: string;
  canonicalSegments: CanonicalSegment[];
} => {
  const originSegments: OriginSegment[] = [];
  const segmentTexts: TranslationSegmentText[] = [];
  const mergedParts: string[] = [];
  const canonicalSegments: CanonicalSegment[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `seg-${index + 1}`;
    const text = `Translated sentence number ${index + 1}`;
    const originText = `Original sentence number ${index + 1}`;
    originSegments.push({
      id,
      index,
      text: originText,
      paragraphIndex: 0,
      sentenceIndex: null,
    });
    segmentTexts.push({
      segmentId: id,
      text,
    });
    mergedParts.push(text);
    canonicalSegments.push({
      id,
      hash: `hash-${index + 1}`,
      segmentOrder: index,
      paragraphIndex: 0,
      sentenceIndex: null,
      startOffset: index * 10,
      endOffset: index * 10 + originText.length,
      overlapPrev: false,
      overlapNext: false,
      overlapTokens: 0,
      tokenEstimate: originText.length,
      tokenBudget: originText.length,
      text: originText,
    });
  }
  return {
    originSegments,
    segmentTexts,
    mergedText: mergedParts.join("\n"),
    canonicalSegments,
  };
};

describe("translationPages", () => {
  test("buildTranslationPages splits large payloads into multiple pages", () => {
    const { originSegments, segmentTexts, mergedText, canonicalSegments } =
      buildSegments(80);

    const { pages, itemCount } = buildTranslationPages({
      runId: "translation:test",
      stage: "draft",
      jobId: "job-123",
      model: "gpt-test",
      mergedText,
      originSegments,
      canonicalSegments,
      segmentTexts,
      usage: { inputTokens: 800, outputTokens: 1600 },
      meta: {
        truncated: false,
        retryCount: 0,
        fallbackModelUsed: false,
        jsonRepairApplied: false,
      },
      latencyMs: 1200,
    });

    assert.equal(itemCount, 80);
    assert.ok(pages.length >= 2, "expected multiple pages when exceeding chunk size");

    pages.forEach((page, index) => {
      const cursor = parseTranslationCursor(page.next_cursor ?? null);
      if (index < pages.length - 1) {
        assert.equal(page.has_more, true);
        assert.ok(cursor, "expected cursor for intermediate pages");
        const expectedHash = pages[index + 1].segment_hashes[0];
        assert.equal(cursor?.stage, "draft");
        assert.equal(cursor?.hash, expectedHash);
        assert.equal(
          page.next_cursor,
          serializeTranslationCursor("draft", expectedHash),
        );
      } else {
        assert.equal(page.has_more, false);
        assert.equal(page.next_cursor, null);
        assert.equal(cursor, null);
      }
      assert.ok(
        Array.isArray(page.segment_hashes) && page.segment_hashes.length,
        "expected segment hashes for each page",
      );
      assert.equal(
        page.segment_hashes.length,
        page.items.length,
        "hash count should align with page items",
      );
    });

    const chunkIds = new Set(pages.map((page) => page.chunk_id));
    assert.equal(chunkIds.size, pages.length, "chunk ids should be unique per page");
  });

  test("parseTranslationCursor handles invalid input", () => {
    assert.equal(parseTranslationCursor(null), null);
    assert.equal(parseTranslationCursor(""), null);
    assert.equal(parseTranslationCursor("draft"), null);
    assert.deepEqual(parseTranslationCursor("draft:2"), {
      stage: "draft",
      hash: null,
      pageIndex: 2,
    });
  });
});
