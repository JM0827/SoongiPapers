import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { OriginSegment } from "../../../agents/translation";
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
} => {
  const originSegments: OriginSegment[] = [];
  const segmentTexts: TranslationSegmentText[] = [];
  const mergedParts: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `seg-${index + 1}`;
    const text = `Translated sentence number ${index + 1}`;
    originSegments.push({
      id,
      index,
      text: `Original sentence number ${index + 1}`,
      paragraphIndex: 0,
      sentenceIndex: null,
    });
    segmentTexts.push({
      segmentId: id,
      text,
    });
    mergedParts.push(text);
  }
  return {
    originSegments,
    segmentTexts,
    mergedText: mergedParts.join("\n"),
  };
};

describe("translationPages", () => {
  test("buildTranslationPages splits large payloads into multiple pages", () => {
    const { originSegments, segmentTexts, mergedText } = buildSegments(80);

    const { pages, itemCount } = buildTranslationPages({
      runId: "translation:test",
      stage: "draft",
      jobId: "job-123",
      model: "gpt-test",
      mergedText,
      originSegments,
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
      } else {
        assert.equal(page.has_more, false);
        assert.equal(page.next_cursor, "");
      }
      const serialized = serializeTranslationCursor("draft", index + 1);
      if (index < pages.length - 1) {
        assert.equal(page.next_cursor, serialized);
      }
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
      pageIndex: 2,
    });
  });
});
