import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildTranslationStages,
  calculatePercentComplete,
  timelineStatusToSummaryStatus,
} from "../../translationSummary";
import type { StageTimelineEntry } from "../../../services/translationSummaryState";

const iso = (value: string): string => new Date(value).toISOString();

describe("translationSummary helpers", () => {
  test("calculatePercentComplete clamps at 99 until micro-check finishes", () => {
    assert.equal(calculatePercentComplete(10, 5, false), 50);
    assert.equal(calculatePercentComplete(10, 10, false), 99);
    assert.equal(calculatePercentComplete(10, 10, true), 100);
    assert.equal(calculatePercentComplete(0, 0, false), 0);
  });

  test("buildTranslationStages prefers timeline timestamps", () => {
    const runStartedAt = iso("2025-11-05T10:00:00Z");
    const runCompletedAt = iso("2025-11-05T11:00:00Z");
    const timeline: StageTimelineEntry = {
      status: "done",
      startedAt: iso("2025-11-05T10:05:00Z"),
      completedAt: iso("2025-11-05T10:30:00Z"),
      itemCount: 42,
      updatedAt: iso("2025-11-05T10:30:00Z"),
    };

    const stages = buildTranslationStages(
      [
        { stage: "draft", status: "done", timeline },
        { stage: "revise", status: "running", timeline: null },
        { stage: "microcheck", status: "queued", timeline: null },
      ],
      runStartedAt,
      runCompletedAt,
    );

    assert.deepEqual(stages[0], {
      stage: "draft",
      status: "done",
      startedAt: timeline.startedAt,
      completedAt: timeline.completedAt,
    });
    assert.deepEqual(stages[1], {
      stage: "revise",
      status: "running",
      startedAt: runStartedAt,
      completedAt: null,
    });
    assert.deepEqual(stages[2], {
      stage: "microcheck",
      status: "queued",
      startedAt: null,
      completedAt: null,
    });
  });

  test("timelineStatusToSummaryStatus maps streaming statuses", () => {
    assert.equal(timelineStatusToSummaryStatus("in_progress"), "running");
    assert.equal(timelineStatusToSummaryStatus("done"), "done");
    assert.equal(timelineStatusToSummaryStatus("error"), "error");
    assert.equal(timelineStatusToSummaryStatus(undefined), null);
  });
});
