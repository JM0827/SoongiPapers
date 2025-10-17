import OpenAI from "openai";
import pLimit from "p-limit";
import type { GuardFindingDetail } from "@bookko/translation-types";

type GuardWorkerSegment = {
  segment_id: string;
  segment_index: number;
  needs_review: boolean;
  guard_findings?: GuardFindingDetail[];
  guards?: Record<string, unknown> | null;
  source_excerpt?: string;
  target_excerpt?: string;
};

type GenericWorkerParams = {
  model: string;
  temperature: number;
  systemPrompt: string;
  subKey: string;
  kr: string;
  en: string;
  kr_id: number | null;
  en_id: number | null;
  guardContext?: {
    segments: GuardWorkerSegment[];
  };
};

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const limit = pLimit(Number(process.env.MAX_WORKERS || 4));

export async function runGenericWorker(p: GenericWorkerParams) {
  const run = () => callOnce(p);
  try {
    return await limit(run);
  } catch {
    return await limit(run);
  }
}

async function callOnce(p: GenericWorkerParams) {
  const guardPayload = buildGuardPayload(p.guardContext);
  const userPayload: Record<string, unknown> = {
    task: p.subKey,
    instruction:
      "Return a JSON object with shape {items:[{issue_ko,issue_en,recommendation_ko,recommendation_en,before,after,alternatives?,rationale_ko,rationale_en,confidence,severity,tags?,notes?}]}",
    constraints: [
      "Preserve semantic content and voice.",
      "Minimize edits unless clearly better.",
      "If no issues, return items:[]",
    ],
    source_text: p.kr,
    target_text: p.en,
  };
  if (guardPayload) {
    userPayload.guard_context = guardPayload;
  }

  const res = await client.chat.completions.create({
    model: p.model,
    temperature: p.temperature,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: p.systemPrompt },
      {
        role: "user",
        content: JSON.stringify(userPayload),
      },
    ],
  });

  const parsed = JSON.parse(res.choices[0].message?.content || "{}");
  const arr = Array.isArray(parsed.items) ? parsed.items : [];
  const guardNotes = buildGuardNotes(p.guardContext);
  const guardSegments = Array.isArray(p.guardContext?.segments)
    ? p.guardContext!.segments
    : [];
  const guardSource = guardSegments.find((segment) => segment.source_excerpt)?.source_excerpt ?? null;
  const guardTarget = guardSegments.find((segment) => segment.target_excerpt)?.target_excerpt ?? null;
  const sourceSentences = splitChunkSentences(p.kr);
  const targetSentences = splitChunkSentences(p.en);

  return arr.map((it: any, idx: number) => {
    const translationFragment =
      it.translationExcerpt ?? it.before ?? guardTarget ?? null;
    const targetSelection = selectSentence(targetSentences, translationFragment);
    const sourceSelection = selectSentence(
      sourceSentences,
      it.sourceExcerpt ?? it.source ?? guardSource,
    );
    const fallbackSource =
      sourceSelection.text ??
      (targetSelection.index >= 0
        ? sourceSentences[targetSelection.index]
        : guardSource ?? sourceSentences[0] ?? p.kr);
    const fallbackTarget =
      targetSelection.text ??
      (sourceSelection.index >= 0
        ? targetSentences[sourceSelection.index]
        : guardTarget ?? translationFragment ?? targetSentences[0] ?? p.en);

    const base: Record<string, unknown> = {
      id: `${p.subKey}-${p.en_id}-${idx}`,
      kr_sentence_id: p.kr_id,
      en_sentence_id: p.en_id,
      issue_ko: it.issue_ko,
      issue_en: it.issue_en,
      recommendation_ko: it.recommendation_ko,
      recommendation_en: it.recommendation_en,
      before: it.before,
      after: it.after,
      alternatives: it.alternatives ?? undefined,
      rationale_ko: it.rationale_ko,
      rationale_en: it.rationale_en,
      spans: it.spans ?? null,
      confidence: it.confidence ?? 0.7,
      severity: it.severity ?? "low",
      tags: it.tags ?? [],
      source: it.source ?? fallbackSource,
      sourceExcerpt: it.sourceExcerpt ?? fallbackSource,
      translationExcerpt: translationFragment ?? fallbackTarget,
    };

    if (guardNotes.length) {
      const existingNotes = isRecord(it.notes) ? { ...it.notes } : {};
      existingNotes.guardFindings = guardNotes;
      base.notes = existingNotes;
    } else if (isRecord(it.notes)) {
      base.notes = it.notes;
    }

    return base;
  });
}

function buildGuardPayload(context?: GenericWorkerParams["guardContext"]) {
  if (!context?.segments?.length) return undefined;
  return {
    flagged_segments: context.segments.map((segment) => ({
      segment_id: segment.segment_id,
      segment_index: segment.segment_index,
      needs_review: segment.needs_review,
      guard_checks: segment.guards ?? null,
      guard_findings: Array.isArray(segment.guard_findings)
        ? segment.guard_findings.map((finding) => ({
            type: finding.type,
            summary: finding.summary,
            severity: finding.severity ?? null,
          }))
        : [],
      source_excerpt: segment.source_excerpt ?? null,
      target_excerpt: segment.target_excerpt ?? null,
    })),
  };
}

function buildGuardNotes(context?: GenericWorkerParams["guardContext"]) {
  if (!context?.segments?.length) return [];
  const notes: Array<{
    type: string;
    summary: string;
    segmentId: string;
    severity?: string;
    needsReview?: boolean;
  }> = [];

  for (const segment of context.segments) {
    const findings = Array.isArray(segment.guard_findings)
      ? segment.guard_findings
      : [];
    for (const finding of findings) {
      notes.push({
        type: finding.type,
        summary: finding.summary,
        segmentId: segment.segment_id,
        severity: finding.severity ?? undefined,
        needsReview: segment.needs_review,
      });
    }
  }

  return notes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function splitChunkSentences(value?: string | null): string[] {
  if (!value) return [];
  return value
    .split(/\r?\n\r?\n+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function selectSentence(
  sentences: string[],
  fragment?: string | null,
): { text: string | null; index: number } {
  if (fragment) {
    const index = sentences.findIndex((sentence) => sentence.includes(fragment));
    if (index >= 0) {
      return { text: sentences[index], index };
    }
  }
  return { text: null, index: -1 };
}
