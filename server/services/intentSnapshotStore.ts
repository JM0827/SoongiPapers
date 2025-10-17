import { query } from "../db";
import type { IntentClassification } from "./intentClassifier";
import type { IntentSnapshot } from "./workflowEvents";

const INTENT_VALUES: ReadonlyArray<IntentClassification["intent"]> = [
  "translate",
  "proofread",
  "quality",
  "status",
  "cancel",
  "other",
];

const isIntentValue = (
  value: unknown,
): value is IntentClassification["intent"] =>
  typeof value === "string" && INTENT_VALUES.includes(value as any);

interface PersistedIntentSnapshot extends IntentSnapshot {}

function serialize(snapshot: IntentSnapshot) {
  return JSON.stringify(snapshot);
}

function parseSnapshot(raw: unknown): PersistedIntentSnapshot | null {
  if (!raw) return null;
  try {
    const value =
      typeof raw === "string"
        ? JSON.parse(raw)
        : (raw as Record<string, unknown>);
    if (!value || typeof value !== "object") return null;
    const rawIntent = (value as { intent?: unknown }).intent;
    const intent = isIntentValue(rawIntent) ? rawIntent : "other";
    const confidence = Number(value.confidence ?? 0);
    const rerun = Boolean(value.rerun);
    const label =
      typeof value.label === "string" && value.label.length
        ? value.label
        : null;
    const notes =
      typeof value.notes === "string" && value.notes.length
        ? value.notes
        : null;
    const effectiveIntent = (() => {
      const rawEffective = (value as { effectiveIntent?: unknown })
        .effectiveIntent;
      if (typeof rawEffective === "string") {
        if (
          rawEffective === "translation" ||
          rawEffective === "proofread" ||
          rawEffective === "quality"
        ) {
          return rawEffective as PersistedIntentSnapshot["effectiveIntent"];
        }
        if (isIntentValue(rawEffective)) {
          return rawEffective as PersistedIntentSnapshot["effectiveIntent"];
        }
      }
      return intent;
    })();
    const updatedAt =
      typeof value.updatedAt === "string"
        ? value.updatedAt
        : new Date().toISOString();

    return {
      intent,
      confidence,
      rerun,
      label,
      notes,
      effectiveIntent,
      updatedAt,
    };
  } catch (error) {
    console.warn("[intent] failed to parse snapshot", error);
    return null;
  }
}

export async function loadIntentSnapshot(
  projectId: string,
  userId: string,
): Promise<PersistedIntentSnapshot | null> {
  try {
    const { rows } = await query(
      `SELECT last_intent
         FROM conversation_intent_snapshots
         WHERE project_id = $1 AND user_id = $2
         LIMIT 1`,
      [projectId, userId],
    );
    if (!rows.length) return null;
    return parseSnapshot(rows[0]?.last_intent ?? null);
  } catch (error: any) {
    if (error?.code === "42P01") {
      // table missing in dev/demo setups; treat as no snapshot
      return null;
    }
    throw error;
  }
}

export async function saveIntentSnapshot(
  projectId: string,
  userId: string,
  snapshot: IntentSnapshot,
): Promise<void> {
  const payload = serialize(snapshot);
  try {
    await query(
      `INSERT INTO conversation_intent_snapshots (project_id, user_id, last_intent, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (project_id, user_id)
         DO UPDATE SET last_intent = EXCLUDED.last_intent, updated_at = NOW()`,
      [projectId, userId, payload],
    );
  } catch (error: any) {
    if (error?.code === "42P01") {
      // Ignore when table not provisioned yet.
      return;
    }
    throw error;
  }
}

export async function clearIntentSnapshot(
  projectId: string,
  userId: string,
): Promise<void> {
  try {
    await query(
      `DELETE FROM conversation_intent_snapshots WHERE project_id = $1 AND user_id = $2`,
      [projectId, userId],
    );
  } catch (error: any) {
    if (error?.code === "42P01") {
      return;
    }
    throw error;
  }
}
