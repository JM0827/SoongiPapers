import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runResponsesWithRetry,
  type ResponsesRetryAttemptContext,
} from "../../openaiResponses";

test("single segment length failure triggers downshift then segment retry", async () => {
  const attempts: ResponsesRetryAttemptContext[] = [];
  const segmentAttempts: ResponsesRetryAttemptContext[] = [];
  let requestCount = 0;

  const result = await runResponsesWithRetry({
    client: {} as any,
    initialMaxOutputTokens: 280,
    maxOutputTokensCap: 1000,
    buildRequest: async (context) => {
      attempts.push(context);
      requestCount += 1;
      return {
        id: `resp-${requestCount}`,
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      };
    },
    retrySegmentFn: async (context) => {
      segmentAttempts.push(context);
      return { id: "segment-1" } as any;
    },
  });

  assert.equal(result.truncated, false);
  assert.equal(result.attempts, 3);
  assert.equal(segmentAttempts.length, 1);
  assert.equal(segmentAttempts[0].stage, "segment");
  assert.deepEqual(
    attempts.map((ctx) => [ctx.stage, ctx.maxOutputTokens]),
    [
      ["primary", 280],
      ["downshift", 196],
    ],
  );
});
