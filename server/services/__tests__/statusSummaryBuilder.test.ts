import { describe, test } from "node:test";
import assert from "node:assert";

import {
  buildStatusSnapshot,
  formatStatusSnapshotForLlm,
} from "../statusSummaryBuilder";

describe("statusSummaryBuilder", () => {
  test("builds snapshot with running translation", () => {
    const snapshot = buildStatusSnapshot({
      state: [
        {
          type: "translation",
          status: "running",
          label: "실험 번역",
          currentRunId: "run-1",
          updatedAt: "2024-01-02T00:00:00Z",
        },
        { type: "quality", status: "idle", label: null, currentRunId: null, updatedAt: null },
      ],
      recentRuns: [],
    } as any);

    assert.strictEqual(snapshot.translation, "translation: running (실험 번역)");
    assert.strictEqual(snapshot.quality, "quality: idle");
    assert.strictEqual(snapshot.anyRunning, true);
  });

  test("formats snapshot for llm", () => {
    const snapshot = buildStatusSnapshot(null);
    const formatted = formatStatusSnapshotForLlm(snapshot);
    assert.strictEqual(
      formatted,
      "translation: idle | proofreading: idle | quality: idle",
    );
  });
});
