import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import { buildAgentItemsPage } from "../genericWorker";
import { AgentItemsResponseSchemaV2 } from "../../../services/responsesSchemas";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const loadFixture = (name: string): string =>
  readFileSync(join(__dirname, "fixtures", name), "utf8");

const toNdjsonLine = (page: ReturnType<typeof buildAgentItemsPage>): string =>
  `${JSON.stringify({ type: "items", data: { page } }, null, 2)}\n`;

describe("buildAgentItemsPage", () => {
  test("short page snapshot", () => {
    const page = buildAgentItemsPage({
      runId: "run_short",
      chunkId: "grammar:0",
      tier: "quick",
      model: "gpt-5-mini-2025-08-07",
      latencyMs: 420,
      promptTokens: 128,
      completionTokens: 96,
      finishReason: "stop",
      truncated: false,
      warnings: ["json_repair_applied"],
      indexBase: 0,
      offsetSemantics: "[start,end)",
      items: [
        {
          k: "grammar",
          s: "error",
          r: "Fix article usage",
          t: "replace",
          i: [0, 0],
          o: [12, 24],
          fix: { text: "the" },
        },
      ],
      hasMore: false,
      nextCursor: null,
      providerResponseId: "resp_short",
      downshiftCount: 0,
      forcedPagination: false,
      cursorRetryCount: 0,
    });

    AgentItemsResponseSchemaV2.parse(page);
    const actual = toNdjsonLine(page);
    assert.equal(actual, loadFixture("short.ndjson"));
  });

  test("truncated page snapshot", () => {
    const page = buildAgentItemsPage({
      runId: "run_trunc",
      chunkId: "style:1",
      tier: "quick",
      model: "gpt-5-mini-2025-08-07",
      latencyMs: 1337,
      promptTokens: 640,
      completionTokens: 512,
      finishReason: "length",
      truncated: true,
      partial: true,
      warnings: ["token_downshift"],
      indexBase: 0,
      offsetSemantics: "[start,end)",
      items: [
        {
          k: "style",
          s: "warning",
          r: "Rephrase to maintain tone",
          t: "replace",
          i: [1, 1],
          o: [34, 58],
          fix: { text: "Please consider revising" },
        },
      ],
      hasMore: true,
      nextCursor: "cursor-001",
      providerResponseId: "resp_trunc",
      downshiftCount: 2,
      forcedPagination: true,
      cursorRetryCount: 1,
    });

    AgentItemsResponseSchemaV2.parse(page);
    const actual = toNdjsonLine(page);
    assert.equal(actual, loadFixture("truncated.ndjson"));
  });

  test("zero item page snapshot", () => {
    const page = buildAgentItemsPage({
      runId: "run_zero",
      chunkId: "consistency:0",
      tier: "quick",
      model: "gpt-5-mini-2025-08-07",
      latencyMs: 205,
      promptTokens: 90,
      completionTokens: 32,
      truncated: false,
      warnings: [],
      indexBase: 0,
      offsetSemantics: "[start,end)",
      items: [],
      hasMore: false,
      nextCursor: null,
      providerResponseId: "resp_zero",
      downshiftCount: 0,
      forcedPagination: false,
      cursorRetryCount: 0,
    });

    AgentItemsResponseSchemaV2.parse(page);
    const actual = toNdjsonLine(page);
    assert.equal(actual, loadFixture("zero.ndjson"));
  });

  test("clamps fix note length", () => {
    const longNote = "n".repeat(200);
    const page = buildAgentItemsPage({
      runId: "run_note",
      chunkId: "style:2",
      tier: "quick",
      model: "gpt-5-mini-2025-08-07",
      latencyMs: 500,
      promptTokens: 100,
      completionTokens: 80,
      truncated: false,
      warnings: [],
      indexBase: 0,
      offsetSemantics: "[start,end)",
      items: [
        {
          k: "style",
          s: "warning",
          r: "Tone adjustment",
          t: "replace",
          i: [0, 0],
          o: [10, 20],
          fix: {
            text: "revised phrase",
            note: longNote,
          },
        },
      ],
      hasMore: false,
      nextCursor: null,
      providerResponseId: "resp_note",
      downshiftCount: 0,
      forcedPagination: false,
      cursorRetryCount: 0,
    });

    AgentItemsResponseSchemaV2.parse(page);
    const note = page.items[0]?.fix?.note ?? "";
    assert.equal(note.length, 120);
  });

  test("has-more fixture preserves event ordering", () => {
    const lines = loadFixture("has-more-run.ndjson")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    assert.equal(lines.length >= 4, true);
    assert.equal(lines[0]?.type, "stage");
    assert.equal(lines[1]?.type, "items");
    assert.equal(lines[2]?.type, "tier_complete");
    assert.equal(lines[3]?.type, "complete");

    const itemsEvent = lines[1] as {
      type: string;
      data: {
        page: unknown;
      };
    };
    const page = AgentItemsResponseSchemaV2.parse(itemsEvent.data.page);

    assert.equal(page.has_more, false);
    assert.equal(page.next_cursor, null);
    assert.equal(page.stats?.item_count, 3);
    assert.equal(page.items.length, 3);
    assert.equal(page.run_id, "61086f79-199e-4478-8e39-0adbb2a7972d");
  });

  test("zero run emits completion events with zero counts", () => {
    const lines = loadFixture("zero-run.ndjson")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    assert.equal(lines.length >= 3, true);
    const stage = lines.find((line) => line.type === "stage") as
      | { data?: Record<string, unknown> }
      | undefined;
    const tierComplete = lines.find((line) => line.type === "tier_complete") as
      | { data?: Record<string, unknown> }
      | undefined;
    const complete = lines.find((line) => line.type === "complete") as
      | { data?: Record<string, unknown> }
      | undefined;

    assert.ok(stage);
    assert.equal(stage?.data?.itemCount ?? stage?.data?.item_count ?? 0, 0);

    assert.ok(tierComplete);
    assert.equal(
      tierComplete?.data?.itemCount ?? tierComplete?.data?.item_count ?? 0,
      0,
    );
    const tierSummary = tierComplete?.data?.summary as
      | Record<string, unknown>
      | undefined;
    assert.equal(
      (tierSummary?.tier_issue_counts as Record<string, number> | undefined)?.quick ?? 0,
      0,
    );

    assert.ok(complete);
    assert.equal(complete?.data?.scope ?? null, "run");
    const runSummary = complete?.data?.summary as
      | { summary?: Record<string, unknown> }
      | undefined;
    assert.equal(
      (runSummary?.summary as { tier_issue_counts?: Record<string, number> } | undefined)?.tier_issue_counts?.quick ?? 0,
      0,
    );
  });
});
