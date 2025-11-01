import type { OpenAI } from "openai";

import { getIntentClassifierDefaults } from "./responsesConfig";
import { intentClassifierSchema } from "./responsesSchemas";
import { runJsonSchemaResponse } from "./responsesRunner";

export type IntentType =
  | "translate"
  | "proofread"
  | "quality"
  | "status"
  | "cancel"
  | "upload"
  | "ebook"
  | "other";

export interface IntentClassification {
  intent: IntentType;
  confidence: number;
  rerun: boolean;
  label?: string | null;
  notes?: string | null;
}

const DEFAULT_INTENT: IntentClassification = {
  intent: "other",
  confidence: 0,
  rerun: false,
  label: null,
  notes: null,
};

const CLASSIFIER_PROMPT = `You are an intent classifier for a literary translation studio assistant.
Your job is to interpret the user's latest message and decide which workflow action they want next.

Return a JSON object with this schema (all keys required, use null when the value is unknown):
{
  "intent": "translate" | "proofread" | "quality" | "status" | "cancel" | "upload" | "ebook" | "other",
  "confidence": number between 0 and 1,
  "rerun": boolean,               // true if the user wants to rerun/redo the workflow even if recently done
  "label": string | null,         // run label supplied by the user (e.g., "실험 번역", "2차 교정"). Return null if not provided.
  "notes": string | null          // any important nuance (max 1 short sentence). Return null when there are no notes.
}

Guidelines:
- If the user explicitly requests a new translation, set intent="translate".
- If they ask for proofreading, intent="proofread".
- If they request a quality evaluation or assessment, intent="quality".
- If they only want to know current status/progress, use intent="status".
- If they want to cancel/stop an ongoing task, intent="cancel".
- If they mention uploading, replacing, or providing the manuscript/origin file, intent="upload".
- If they ask to prepare, export, or download an ebook file, intent="ebook".
- Otherwise respond with intent="other".
- Set rerun=true when the user says "다시", "rerun", "repeat", or similar.
- Extract a short label if provided (e.g., "이번 번역을 '실험 번역'으로 기록해줘"). If no label, return null.
- Always respond with valid JSON only.`;

export interface IntentContextMetadata {
  translationStage?: string;
  proofreadingStage?: string;
  qualityStage?: string;
}

export async function classifyIntent(
  openai: OpenAI,
  userMessage: string,
  metadata: IntentContextMetadata,
): Promise<IntentClassification> {
  try {
    const defaults = getIntentClassifierDefaults();
    const result = await runJsonSchemaResponse<IntentClassification>({
      client: openai,
      model: defaults.model,
      maxOutputTokens: defaults.maxOutputTokens,
      maxOutputTokensCap: defaults.maxOutputTokens,
      verbosity: defaults.verbosity,
      reasoningEffort: defaults.reasoningEffort,
      schema: intentClassifierSchema,
      messages: [
        { role: "system", content: CLASSIFIER_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            message: userMessage,
            context: metadata,
          }),
        },
      ],
    });

    const parsed = result.parsed ?? DEFAULT_INTENT;
    const maybeIntent = parsed.intent as IntentType | undefined;
    if (!maybeIntent) {
      return DEFAULT_INTENT;
    }

    const confidence = Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0;

    return {
      intent: maybeIntent,
      confidence,
      rerun: Boolean(parsed.rerun),
      label:
        typeof parsed.label === "string" && parsed.label.trim()
          ? parsed.label.trim()
          : null,
      notes:
        typeof parsed.notes === "string" && parsed.notes.trim()
          ? parsed.notes.trim()
          : null,
    } satisfies IntentClassification;
  } catch (error) {
    console.warn("[intent] failed to classify", error);
    return DEFAULT_INTENT;
  }
}
