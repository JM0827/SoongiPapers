import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  segmentCanonicalText,
  type CanonicalSegmentationOptions,
} from "../segmentationEngine";

describe("segmentationEngine", () => {
  const paragraphText = `첫 번째 문단입니다. 두 번째 문장입니다.\n\nSecond paragraph sentence one. Second paragraph sentence two.`;

  const baseOptions: CanonicalSegmentationOptions = {
    text: paragraphText,
    projectId: "project-1",
  };

  test("paragraph mode returns paragraphs with overlap metadata", async () => {
    const result = await segmentCanonicalText(baseOptions);

    assert.equal(result.segments.length, 2);
    assert.equal(result.mode, "paragraph");

    const [first, second] = result.segments;
    assert.equal(first.segmentOrder, 0);
    assert.equal(first.overlapPrev, false);
    assert.equal(first.overlapNext, true);
    assert.equal(second.overlapPrev, true);
    assert.equal(second.overlapNext, false);
    assert.ok(second.overlapTokens > 0);
  });

  test("sentence mode yields one segment per sentence", async () => {
    const result = await segmentCanonicalText({
      ...baseOptions,
      modeOverride: "sentence",
    });
    assert.equal(result.mode, "sentence");
    const sentences = paragraphText.split(/\n+/);
    // there are four sentences overall
    assert.equal(result.segments.length, 4);
    assert.ok(result.segments.every((segment) => segment.overlapTokens === 0));
  });

  test("long sentence is split respecting cap", async () => {
    const longSentence = `${"a".repeat(2000)}.`;
    const text = `${longSentence}\n\nShort follow up.`;
    const result = await segmentCanonicalText({
      ...baseOptions,
      text,
      modeOverride: "sentence",
    });

    assert.ok(result.segments.length >= 2);
    const longSegments = result.segments.filter((segment) =>
      segment.text.includes("a".repeat(10)),
    );
    assert.ok(longSegments.length >= 2);
    assert.ok(longSegments.every((segment) => segment.tokenEstimate <= 600));
  });
});
