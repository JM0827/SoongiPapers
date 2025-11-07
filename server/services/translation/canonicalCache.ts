import { query } from "../../db";

export type CanonicalCacheState = "ready" | "warming" | "missing";

export interface CanonicalCacheSnapshot {
  state: CanonicalCacheState;
  updatedAt: string | null;
}

interface CanonicalCacheExtrasLike {
  canonicalCache?: {
    state?: CanonicalCacheState;
    updatedAt?: string | null;
  } | null;
}

async function hasCanonicalSegments(runId: string): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1 FROM translation_segment_meta WHERE run_id = $1 LIMIT 1`,
    [runId],
  );
  return rows.length > 0;
}

export async function getCanonicalCacheState(params: {
  runId: string;
  extras?: CanonicalCacheExtrasLike | null;
}): Promise<CanonicalCacheSnapshot> {
  const extrasState = params.extras?.canonicalCache?.state;
  const extrasUpdatedAt = params.extras?.canonicalCache?.updatedAt ?? null;

  if (extrasState === "ready") {
    return { state: "ready", updatedAt: extrasUpdatedAt };
  }

  const ready = await hasCanonicalSegments(params.runId);
  if (ready) {
    return { state: "ready", updatedAt: new Date().toISOString() };
  }

  if (extrasState === "warming") {
    return { state: "warming", updatedAt: extrasUpdatedAt };
  }

  return { state: "missing", updatedAt: extrasUpdatedAt };
}
