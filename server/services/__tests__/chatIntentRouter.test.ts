import { describe, test } from "node:test";
import assert from "node:assert";

import { handleIntentRouting, type IntentRoutingPreflight } from "../chatIntentRouter";
import type { IntentClassification } from "../intentClassifier";
import type { WorkflowRunRecord } from "../workflowManager";

const buildRun = (overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord => ({
  runId: "run-1",
  projectId: "proj-1",
  type: "translation",
  status: "running",
  requestedBy: "user-1",
  intentText: "번역 시작",
  label: overrides.label ?? "테스트 번역",
  parentRunId: null,
  metadata: null,
  startedAt: new Date().toISOString(),
  completedAt: null,
  updatedAt: new Date().toISOString(),
  sequence: 1,
  ...overrides,
});

describe("handleIntentRouting", () => {
  test("routes translation intent and returns localized success", async () => {
    const classification: IntentClassification = {
      intent: "translate",
      confidence: 0.9,
      rerun: false,
      label: null,
      notes: null,
    };

    const preflight: IntentRoutingPreflight = {
      actions: [
        {
          type: "startTranslation",
          autoStart: true,
          allowParallel: false,
          label: "실험 번역",
        },
      ],
      notes: ["진행 상황은 타임라인에서 확인해 주세요."],
      effectiveIntent: "translation",
      effectiveLabel: "실험 번역",
    };

    const result = await handleIntentRouting({
      locale: "ko",
      classification,
      preflight,
      latestUserMessage: "번역 시작해줘",
      userId: "user-1",
      projectId: "proj-1",
      requestAction: async () => ({
        accepted: true,
        run: buildRun({ label: "실험 번역" }),
      }),
    });

    assert.ok(result.handled);
    assert.ok(result.llmContext?.includes("번역을 바로 시작할게요"));
    assert.ok(result.llmContext?.includes("실험 번역"));
    assert.ok(result.llmContext?.includes("진행 상황은 타임라인에서 확인해 주세요."));
    assert.deepStrictEqual(result.actions, [{ type: "viewTranslationStatus" }]);
    assert.strictEqual(result.classificationForEvent?.label, "실험 번역");
  });

  test("handles proofread conflict and keeps follow-up action", async () => {
    const classification: IntentClassification = {
      intent: "proofread",
      confidence: 0.8,
      rerun: false,
      label: null,
      notes: null,
    };

    const preflight: IntentRoutingPreflight = {
      actions: [
        {
          type: "startProofread",
          autoStart: true,
        },
      ],
      notes: [],
      effectiveIntent: "proofread",
      effectiveLabel: null,
    };

    const result = await handleIntentRouting({
      locale: "en",
      classification,
      preflight,
      latestUserMessage: "please proofread again",
      userId: "user-42",
      projectId: "proj-9",
      requestAction: async () => ({
        accepted: false,
        reason: "already_running",
        conflictStatus: "running",
        conflictRun: buildRun({ type: "proofread", label: "Proof pass" }),
      }),
    });

    assert.ok(result.handled);
    assert.ok(result.llmContext?.toLowerCase().includes("proofreading"));
    assert.deepStrictEqual(result.actions, [{ type: "viewTranslationStatus" }]);
  });

  test("reports quality routing failure when requestAction throws", async () => {
    const classification: IntentClassification = {
      intent: "quality",
      confidence: 0.95,
      rerun: false,
      label: null,
      notes: null,
    };

    const preflight: IntentRoutingPreflight = {
      actions: [
        {
          type: "startQuality",
          autoStart: true,
        },
      ],
      notes: [],
      effectiveIntent: "quality",
      effectiveLabel: null,
    };

    const result = await handleIntentRouting({
      locale: "en",
      classification,
      preflight,
      latestUserMessage: "run a quality check",
      userId: null,
      projectId: "proj-17",
      requestAction: async () => {
        throw new Error("network down");
      },
    });

    assert.ok(result.handled);
    assert.match(result.llmContext ?? "", /I couldn't start the quality review/);
    assert.deepStrictEqual(result.actions, [{ type: "viewQualityReport" }]);
  });

  test("returns handled=false when no routable actions", async () => {
    const classification: IntentClassification = {
      intent: "other",
      confidence: 0.2,
      rerun: false,
      label: null,
      notes: null,
    };

    const preflight: IntentRoutingPreflight = {
      actions: [{ type: "acknowledge" }],
      notes: [],
      effectiveIntent: "other",
      effectiveLabel: null,
    };

    const result = await handleIntentRouting({
      locale: "en",
      classification,
      preflight,
      latestUserMessage: "hello",
      userId: null,
      projectId: "proj-1",
      requestAction: async () => ({ accepted: false }),
    });

    assert.strictEqual(result.handled, false);
  });
});
