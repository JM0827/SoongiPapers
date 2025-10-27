import type {
  SequentialStageJob,
  SequentialStageResult,
  TranslationStage,
} from "../../agents/translation";
import { query } from "../../db";

let ensuredDraftSchema = false;

async function ensureTranslationDraftSchema(): Promise<void> {
  if (ensuredDraftSchema) return;
  try {
    await query(
      "ALTER TABLE translation_drafts ADD COLUMN IF NOT EXISTS segment_id TEXT",
      [],
    );
  } catch (error) {
    // ignore – migrations may not permit DDL at runtime in some deployments
  }

  try {
    await query(
      "ALTER TABLE translation_drafts ADD COLUMN IF NOT EXISTS span_pairs JSONB",
      [],
    );
  } catch (error) {
    // ignore
  }

  try {
    await query(
      "ALTER TABLE translation_drafts ADD COLUMN IF NOT EXISTS candidates JSONB",
      [],
    );
  } catch (error) {
    // ignore
  }

  try {
    await query(
      "ALTER TABLE translation_drafts DROP CONSTRAINT IF EXISTS translation_drafts_stage_check",
      [],
    );
    await query(
      "ALTER TABLE translation_drafts ADD CONSTRAINT translation_drafts_stage_check CHECK (stage IN ('literal','style','emotion','qa','draft','revise','micro-check'))",
      [],
    );
  } catch (error) {
    // ignore
  }

  try {
    await query(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_translation_drafts_job_stage ON translation_drafts (job_id, stage, segment_index)",
      [],
    );
  } catch (error) {
    // ignore; if index creation fails (e.g., duplicate rows) the insert below will surface the issue
  }

  ensuredDraftSchema = true;
}

interface StageRecord {
  segmentId: string;
  segmentIndex: number;
  textSource: string;
  textTarget: string | null;
  backTranslation: string | null;
  baselineJson: string | null;
  scoresJson: string | null;
  guardsJson: string | null;
  notesJson: string | null;
  spanPairsJson: string | null;
  candidatesJson: string | null;
  needsReview: boolean;
}

function serializeRecord(
  job: SequentialStageJob,
  result: SequentialStageResult,
): StageRecord | null {
  const segment = job.segmentBatch.find(
    (entry) => entry.segmentId === result.segmentId,
  );
  if (!segment) {
    return null;
  }

  const baseline = result.baseline ?? segment.baseline ?? null;
  const scores = result.scores ?? null;
  const guards = result.guards ?? null;
  const notes = result.notes ?? null;
  const backTranslation =
    extractBackTranslation(result) ?? extractBackTranslation(notes) ?? null;
  const spanPairs = result.spanPairs ?? null;
  const candidates = result.candidates ?? null;

  const needsReview =
    job.stage === "qa" || job.stage === "micro-check"
      ? !(guards?.allOk ?? true)
      : false;

  return {
    segmentId: segment.segmentId,
    segmentIndex: segment.segmentIndex,
    textSource: segment.textSource,
    textTarget: result.textTarget ?? null,
    backTranslation,
    baselineJson: baseline ? JSON.stringify(baseline) : null,
    scoresJson: scores ? JSON.stringify(scores) : null,
    guardsJson: guards ? JSON.stringify(guards) : null,
    notesJson: notes ? JSON.stringify(notes) : null,
    spanPairsJson: spanPairs ? JSON.stringify(spanPairs) : null,
    candidatesJson: Array.isArray(candidates) && candidates.length
      ? JSON.stringify(candidates)
      : null,
    needsReview,
  };
}

export async function persistStageResults(
  job: SequentialStageJob,
  stageResults: SequentialStageResult[],
): Promise<void> {
  await ensureTranslationDraftSchema();
  const records = stageResults
    .map((result) => serializeRecord(job, result))
    .filter((record): record is StageRecord => record !== null);

  if (!records.length) {
    return;
  }

  const values: string[] = [];
  const params: unknown[] = [];
  let index = 1;

  const retryCount = job.retryContext?.attempt ?? 0;

  for (const record of records) {
    values.push(
      `($${index++}, $${index++}, $${index++}, $${index++}, $${index++}, $${index++}, $${index++}, $${index++}, $${index++}, $${index++}, $${index++}, $${index++}, $${index++}, $${index++}, $${index++}, $${index++}, $${index++}, $${index++}, NOW())`,
    );
    params.push(
      job.projectId,
      job.jobId,
      job.stage,
      record.segmentIndex,
      record.segmentId,
      job.config.sourceLang,
      job.config.targetLang,
      record.textSource,
      record.textTarget,
      record.backTranslation,
      record.baselineJson,
      record.scoresJson,
      record.guardsJson,
      record.notesJson,
      record.spanPairsJson,
      record.candidatesJson,
      record.needsReview,
      retryCount,
    );
  }

  const sql = `
    INSERT INTO translation_drafts (
      project_id,
      job_id,
      stage,
      segment_index,
      segment_id,
      source_lang,
      target_lang,
      text_source,
      text_target,
      back_translation,
      baseline,
      scores,
      guards,
      notes,
      span_pairs,
      candidates,
      needs_review,
      retry_count,
      updated_at
    )
    VALUES ${values.join(', ')}
    ON CONFLICT (job_id, stage, segment_index)
    DO UPDATE SET
      text_target = EXCLUDED.text_target,
      back_translation = EXCLUDED.back_translation,
      baseline = EXCLUDED.baseline,
      scores = EXCLUDED.scores,
      guards = EXCLUDED.guards,
      notes = EXCLUDED.notes,
      span_pairs = EXCLUDED.span_pairs,
      candidates = EXCLUDED.candidates,
      needs_review = EXCLUDED.needs_review,
      retry_count = EXCLUDED.retry_count,
      updated_at = NOW();
  `;

  await query(sql, params);
}

export interface StageDraftRecord {
  id: string;
  projectId: string;
  jobId: string;
  stage: TranslationStage;
  segmentIndex: number;
  segmentId: string;
  textSource: string;
  textTarget?: string;
  scores?: Record<string, unknown>;
  guards?: Record<string, unknown>;
  baseline?: Record<string, unknown>;
  retryCount: number;
  needsReview: boolean;
}

function extractBackTranslation(source: unknown): string | null {
  if (!source || typeof source !== "object") {
    return null;
  }
  const record = source as Record<string, unknown>;
  const direct =
    record.backTranslation ??
    record.back_translation ??
    record.backtranslation ??
    record.qa_back_translation;
  if (typeof direct === "string" && direct.trim().length) {
    return direct.trim();
  }
  return null;
}
