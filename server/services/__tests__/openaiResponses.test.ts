import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  runResponsesWithRetry,
  RESPONSES_INCOMPLETE_ERROR_CODE,
  type ResponsesRetryAttemptContext,
} from "../openaiResponses";

describe("runResponsesWithRetry", () => {
  test("retries truncated Responses call with increased token budget", async () => {
    const attempts: Array<{ maxOutputTokens: number; attemptIndex: number }> =
      [];
    let callCount = 0;

    const attemptHistory: ResponsesRetryAttemptContext[] = [];

    const result = await runResponsesWithRetry({
      client: {} as any,
      initialMaxOutputTokens: 300,
      maxOutputTokensCap: 2000,
      minOutputTokens: 200,
      maxAttempts: 5,
      buildRequest: async ({ maxOutputTokens, attemptIndex }) => {
        attempts.push({ maxOutputTokens, attemptIndex });
        callCount += 1;

        if (callCount === 1) {
          const err = new Error("incomplete response") as Error & {
            code?: string;
          };
          err.code = RESPONSES_INCOMPLETE_ERROR_CODE;
          throw err;
        }

        return { id: "resp-ok" };
      },
      onAttempt: (context) => {
        attemptHistory.push(context);
      },
    });

    assert.equal(callCount, 2);
    assert.deepEqual(
      attempts.map((it) => it.maxOutputTokens),
      [300, 210],
    );
    assert.deepEqual(
      attemptHistory.map((it) => it.stage),
      ["primary", "downshift"],
    );
    assert.equal(result.attempts, 2);
    assert.equal(result.maxOutputTokens, 210);
    assert.equal(result.truncated, false);
  });

  test("retries malformed JSON response and applies SyntaxError backoff", async () => {
    const attempts: number[] = [];
    let callCount = 0;

    const attemptHistory: ResponsesRetryAttemptContext[] = [];

    const result = await runResponsesWithRetry({
      client: {} as any,
      initialMaxOutputTokens: 150,
      maxOutputTokensCap: 1000,
      buildRequest: async ({ maxOutputTokens }) => {
        attempts.push(maxOutputTokens);
        callCount += 1;

        if (callCount === 1) {
          throw new SyntaxError("Unexpected token < in JSON");
        }

        return { id: "resp-after-retry" };
      },
      onAttempt: (context) => attemptHistory.push(context),
    });

    assert.equal(callCount, 2);
    assert.deepEqual(attempts, [150, 150]);
    assert.deepEqual(
      attemptHistory.map((it) => it.stage),
      ["primary", "downshift"],
    );
    assert.equal(result.attempts, 2);
    assert.equal(result.maxOutputTokens, 150);
    assert.equal(result.truncated, false);
  });

  test("bubbles non-retryable errors from buildRequest", async () => {
    await assert.rejects(
      () =>
        runResponsesWithRetry({
          client: {} as any,
          initialMaxOutputTokens: 400,
          maxOutputTokensCap: 800,
          buildRequest: async () => {
            throw new Error("fatal");
          },
        }),
      /fatal/,
    );
  });
});

test("handles length incomplete via downshift and segment retry", async () => {
  const primaryAttempts: Array<{ stage: string; maxOutputTokens: number }> = [];
  const segmentAttempts: Array<ResponsesRetryAttemptContext> = [];
  let requestCount = 0;

  const result = await runResponsesWithRetry({
    client: {} as any,
    initialMaxOutputTokens: 320,
    maxOutputTokensCap: 1000,
    buildRequest: async (context) => {
      primaryAttempts.push({ stage: context.stage, maxOutputTokens: context.maxOutputTokens });
      requestCount += 1;
      return {
        id: `resp-${requestCount}`,
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      };
    },
    retrySegmentFn: async (context) => {
      segmentAttempts.push(context);
      return { id: "segment-success" };
    },
  });

  assert.equal(result.attempts, 3);
  assert.equal(result.truncated, false);
  assert.equal(result.maxOutputTokens, 320);
  assert.deepEqual(
    primaryAttempts.map((attempt) => attempt.stage),
    ["primary", "downshift"],
  );
  assert.deepEqual(
    primaryAttempts.map((attempt) => attempt.maxOutputTokens),
    [320, 224],
  );
  assert.equal(segmentAttempts.length, 1);
  assert.equal(segmentAttempts[0].stage, "segment");
  assert.equal(segmentAttempts[0].maxOutputTokens, 320);
});
