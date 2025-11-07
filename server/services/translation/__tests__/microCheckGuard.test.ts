import { describe, expect, it } from "vitest";

import type { OriginSegment } from "../../../agents/translation/segmentationAgent";
import type { TranslationReviseSegmentResult } from "../../../agents/translation/reviseAgent";
import { runMicroChecks } from "../microCheckGuard";

const buildOrigin = (id: string, text: string, paragraphIndex = 0): OriginSegment => ({
  id,
  index: 0,
  text,
  paragraphIndex,
  sentenceIndex: 0,
});

const buildRevision = (
  id: string,
  text: string,
): TranslationReviseSegmentResult => ({
  segment_id: id,
  revised_segment: text,
});

describe("runMicroChecks", () => {
  it("marks segments as ok when ratio is within range", () => {
    const origin = [buildOrigin("seg-0001", "원문 문장입니다.")];
    const revised = [buildRevision("seg-0001", "This is a sentence.")];

    const result = runMicroChecks({ originSegments: origin, revisedSegments: revised });

    expect(result.violationCount).toBe(0);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].guards.lengthOk).toBe(true);
    expect(result.segments[0].needsFollowup).toBe(false);
    expect(result.tokenBudget).toBeUndefined();
  });

  it("flags segments outside ratio bounds without setting needsFollowup", () => {
    const origin = [buildOrigin("seg-0001", "짧은 원문")];
    const revised = [
      buildRevision(
        "seg-0001",
        "This translated sentence is intentionally very long to force the ratio calculation to exceed the upper threshold.",
      ),
    ];

    const result = runMicroChecks({ originSegments: origin, revisedSegments: revised });

    expect(result.violationCount).toBe(1);
    expect(result.segments[0].guards.lengthOk).toBe(false);
    expect(result.segments[0].needsFollowup).toBe(false);
    expect(result.segments[0].notes.guardFindings).toHaveLength(1);
    expect(result.tokenBudget).toBeUndefined();
  });
});
