import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ProofreadingReport, ResultBucket } from "../../agents/proofreading/config";
import type { ProofreadRunSummaryResponse } from "../proofreadSummary";
import { buildProofreadItemsSliceFromSummary } from "../proofreadSummary";

const buildIssue = (id: string): ResultBucket => ({
  group: "style",
  subfeatureKey: `sf_${id}`,
  subfeatureLabel: `Label ${id}`,
  items: [
    {
      id: `issue_${id}`,
      kr_sentence_id: 1,
      en_sentence_id: 1,
      issue_ko: "문장을 다듬어 주세요",
      issue_en: "Tighten the sentence",
      recommendation_ko: "추천 교정안",
      recommendation_en: "Suggested fix",
      before: "원문",
      after: `수정 문장 ${id}`,
      rationale_ko: "이유 설명",
      rationale_en: "Because it improves clarity.",
      confidence: 0.6,
      severity: "medium",
      evidence: [
        {
          reference: "target",
          quote: "Sample quote",
        },
      ],
      spans: { start: 0, end: 4 },
    },
  ],
});

const buildTierReport = (ids: string[]): ProofreadingReport => ({
  meta: {
    schemaVersion: "1.0",
    source: { lang: "ko", path: "src" },
    target: { lang: "en", path: "tgt" },
    alignment: "sentence",
    generatedAt: new Date().toISOString(),
    llm: {
      runs: ids.map((id, index) => ({
        tier: "quick",
        subfeatureKey: `sf_${id}`,
        subfeatureLabel: `Label ${id}`,
        chunkIndex: index,
        model: "gpt-proofread-mini",
        maxOutputTokens: 512,
        attempts: 1,
        truncated: false,
        requestId: `req_${id}`,
        usage: {
          promptTokens: 100,
          completionTokens: 80,
          totalTokens: 180,
        },
        verbosity: "low",
        reasoningEffort: "minimal",
        guardSegments: 1,
        memoryContextVersion: 1,
        downshiftCount: 0,
        forcedPaginationCount: 0,
        cursorRetryCount: 0,
      })),
    },
  },
  results: ids.map((id) => buildIssue(id)),
  summary: {
    countsBySubfeature: Object.fromEntries(ids.map((id) => [`sf_${id}`, 1])),
    tier_issue_counts: { quick: ids.length },
    item_count: ids.length,
  },
});

const buildSummary = (ids: string[]): ProofreadRunSummaryResponse => ({
  projectId: "proj_has_more",
  runId: "run_has_more",
  runStatus: "done",
  runCreatedAt: new Date().toISOString(),
  runCompletedAt: new Date().toISOString(),
  lastLogAt: new Date().toISOString(),
  jobId: "job_has_more",
  translationFileId: "tf_123",
  memoryVersion: 1,
  finalTextHash: "hash",
  proofreading: {
    id: "proof_has_more",
    status: "completed",
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  },
  workflowRun: null,
  report: null,
  tierReports: {
    quick: buildTierReport(ids),
  },
  updatedAt: new Date().toISOString(),
  streamMeta: {
    runId: "run_has_more",
    projectId: "proj_has_more",
    connectionCount: 1,
    reconnectAttempts: 0,
    lastConnectionAt: new Date().toISOString(),
    lastDisconnectionAt: null,
    lastHeartbeatAt: null,
    lastEventAt: null,
    lastEventType: null,
    fallbackCount: 0,
    lastFallbackAt: null,
    lastFallbackReason: null,
  },
});

describe("getProofreadItemsSlice", () => {
  test("buildProofreadItemsSliceFromSummary paginates entries", () => {
    const summary = buildSummary(["a", "b", "c", "d", "e"]);

    const firstSlice = buildProofreadItemsSliceFromSummary(summary, {
      fallbackRunId: "run_has_more",
      cursor: null,
      limit: 2,
    });

    assert.ok(firstSlice);
    assert.equal(firstSlice.slice.events.length, 2);
    assert.equal(firstSlice.slice.hasMore, true);
    assert.equal(firstSlice.slice.total, 5);
    assert.equal(firstSlice.slice.nextCursor, "2");

    const secondSlice = buildProofreadItemsSliceFromSummary(summary, {
      fallbackRunId: "run_has_more",
      cursor: firstSlice.slice.nextCursor,
      limit: 2,
    });

    assert.ok(secondSlice);
    assert.equal(secondSlice.slice.events.length, 2);
    assert.equal(secondSlice.slice.hasMore, true);
    assert.equal(secondSlice.slice.nextCursor, "4");

    const finalSlice = buildProofreadItemsSliceFromSummary(summary, {
      fallbackRunId: "run_has_more",
      cursor: secondSlice.slice.nextCursor,
      limit: 2,
    });

    assert.ok(finalSlice);
    assert.equal(finalSlice.slice.events.length, 1);
    assert.equal(finalSlice.slice.hasMore, false);
    assert.equal(finalSlice.slice.nextCursor, null);
  });

  test("zero-item summary still yields empty slice without errors", () => {
    const summary = buildSummary([]);

    const first = buildProofreadItemsSliceFromSummary(summary, {
      fallbackRunId: "run_has_more",
      cursor: null,
      limit: 2,
    });

    assert.ok(first);
    assert.equal(first.slice.events.length, 0);
    assert.equal(first.slice.hasMore, false);
    assert.equal(first.slice.total, 0);
    assert.equal(first.slice.nextCursor, null);
  });
});
