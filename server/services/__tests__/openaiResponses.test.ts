import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  runResponsesWithRetry,
  RESPONSES_INCOMPLETE_ERROR_CODE,
} from "../openaiResponses";

describe("runResponsesWithRetry", () => {
  test("retries truncated Responses call with increased token budget", async () => {
    const attempts: Array<{ maxOutputTokens: number; attemptIndex: number }> =
      [];
    let callCount = 0;

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
    });

    assert.equal(callCount, 2);
    assert.deepEqual(
      attempts.map((it) => it.maxOutputTokens),
      [300, 210],
    );
    assert.equal(result.attempts, 2);
    assert.equal(result.maxOutputTokens, 210);
    assert.equal(result.truncated, false);
  });

  test("retries malformed JSON response and applies SyntaxError backoff", async () => {
    const attempts: number[] = [];
    let callCount = 0;

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
    });

    assert.equal(callCount, 2);
    assert.deepEqual(attempts, [200, 200]);
    assert.equal(result.attempts, 2);
    assert.equal(result.maxOutputTokens, 200);
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
