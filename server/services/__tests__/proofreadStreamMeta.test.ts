import assert from "node:assert/strict";
import { describe, beforeEach, test } from "node:test";

import {
  getProofreadStreamMeta,
  recordProofreadConnectionClose,
  recordProofreadConnectionOpen,
  recordProofreadEvent,
  recordProofreadFallback,
  recordProofreadHeartbeat,
  resetProofreadStreamMeta,
} from "../proofreadStreamMeta";

describe("proofreadStreamMeta", () => {
  const runId = "run_meta";
  const projectId = "proj_meta";

  beforeEach(() => {
    process.env.DISABLE_STREAM_META_PERSIST = "1";
    resetProofreadStreamMeta();
  });

  test("tracks connection attempts and derived reconnects", () => {
    recordProofreadConnectionOpen({ runId, projectId });
    recordProofreadConnectionClose(runId);
    recordProofreadConnectionOpen({ runId, projectId });

    const meta = getProofreadStreamMeta(runId);
    assert.ok(meta);
    assert.equal(meta?.connectionCount, 2);
    assert.equal(meta?.reconnectAttempts, 1);
    assert.equal(meta?.projectId, projectId);
    assert.ok(meta?.lastConnectionAt);
    assert.ok(meta?.lastDisconnectionAt);
  });

  test("captures heartbeat, events, and fallback", () => {
    recordProofreadConnectionOpen({ runId, projectId });
    recordProofreadHeartbeat({ runId, projectId });
    recordProofreadEvent({ runId, projectId, type: "items" });
    recordProofreadFallback({ runId, projectId, reason: "not_found" });

    const meta = getProofreadStreamMeta(runId);
    assert.ok(meta);
    assert.equal(meta?.lastEventType, "items");
    assert.equal(meta?.fallbackCount, 1);
    assert.equal(meta?.lastFallbackReason, "not_found");
    assert.ok(meta?.lastHeartbeatAt);
    assert.ok(meta?.lastEventAt);
    assert.ok(meta?.lastFallbackAt);
  });

  test("returns null when meta not recorded", () => {
    const meta = getProofreadStreamMeta("unknown");
    assert.equal(meta, null);
  });
});
