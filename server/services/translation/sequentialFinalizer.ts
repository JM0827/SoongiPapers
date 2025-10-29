import TranslationFile from "../../models/TranslationFile";
import TranslationSegment from "../../models/TranslationSegment";
import TranslationDraft from "../../models/TranslationDraft";
import type { OriginSegment } from "../../agents/translation/segmentationAgent";
import type { SequentialStageJob } from "../../agents/translation";
import { query } from "../../db";
import { mergeProjectMemory } from "./memory";

interface FinalizeResult {
  finalized: boolean;
  translationFileId?: string;
  needsReviewCount: number;
  completedNow: boolean;
}

export async function finalizeSequentialJob(
  job: SequentialStageJob,
): Promise<FinalizeResult> {
  const { jobId } = job;
  const counts = await query(
    `SELECT
        COUNT(*) FILTER (WHERE stage = 'literal') AS literal_count,
        COUNT(*) FILTER (WHERE stage = 'qa') AS qa_count
       FROM translation_drafts
      WHERE job_id = $1`,
    [jobId],
  );

  const literalCount = Number(counts.rows?.[0]?.literal_count ?? 0);
  const qaCount = Number(counts.rows?.[0]?.qa_count ?? 0);

  if (literalCount === 0 || qaCount < literalCount) {
    return { finalized: false, needsReviewCount: 0, completedNow: false };
  }

  const emotionRows = await query(
    `SELECT segment_index, segment_id, text_target
       FROM translation_drafts
      WHERE job_id = $1 AND stage = 'emotion'
      ORDER BY segment_index ASC`,
    [jobId],
  );

  if (!emotionRows.rowCount) {
    return { finalized: false, needsReviewCount: 0, completedNow: false };
  }

  const literalRows = await query(
    `SELECT segment_index, segment_id, text_source
       FROM translation_drafts
      WHERE job_id = $1 AND stage = 'literal'
      ORDER BY segment_index ASC`,
    [jobId],
  );

  const qaRows = await query(
    `SELECT segment_index, segment_id, guards, notes, back_translation, needs_review
       FROM translation_drafts
      WHERE job_id = $1 AND stage = 'qa'`,
    [jobId],
  );

  type LiteralRow = {
    segment_index: number;
    segment_id: string;
    text_source: string | null;
  };
  type EmotionRow = {
    segment_index: number;
    segment_id: string;
    text_target: string | null;
  };
  type QaRow = {
    segment_index: number;
    segment_id: string;
    guards: Record<string, unknown> | null;
    notes: Record<string, unknown> | null;
    back_translation: string | null;
    needs_review: boolean | null;
  };

  const literalEntries = (literalRows.rows ?? []) as LiteralRow[];
  const emotionEntries = (emotionRows.rows ?? []) as EmotionRow[];
  const qaEntries = (qaRows.rows ?? []) as QaRow[];

  const paragraphIndexMap = await loadParagraphIndexMap(jobId);

  const literalMap = new Map(
    literalEntries.map((row) => [row.segment_id, row.text_source ?? ""]),
  );

  const qaMap = new Map(
    qaEntries.map((row) => [row.segment_index, row]),
  );

  const originSegments: OriginSegment[] = literalEntries.map((row) => ({
    id: row.segment_id,
    index: row.segment_index,
    text: row.text_source ?? "",
    paragraphIndex:
      paragraphIndexMap.get(row.segment_id) ?? paragraphIndexMap.get(String(row.segment_index)) ?? 0,
    sentenceIndex: null,
  }));

  const resultSegments = emotionEntries.map((row) => ({
    segment_id: row.segment_id,
    translation_segment: row.text_target ?? "",
  }));

  const mergedText = joinWithParagraphs(
    resultSegments.map((segment, index) => ({
      text: (segment.translation_segment ?? "").trim(),
      paragraphIndex: originSegments[index]?.paragraphIndex ?? 0,
    })),
  ).trim();

  const originText = joinWithParagraphs(
    originSegments.map((segment) => ({
      text: segment.text.trim(),
      paragraphIndex: segment.paragraphIndex ?? 0,
    })),
  ).trim();

  const originFilename = `origin-${jobId}.txt`;
  const originFileSize = Buffer.byteLength(originText, "utf8");

  const now = new Date();

  const translationFile = await TranslationFile.findOneAndUpdate(
    { project_id: job.projectId, job_id: job.jobId },
    {
      project_id: job.projectId,
      job_id: job.jobId,
      variant: "final",
      is_final: true,
      source_hash: job.sourceHash ?? null,
      synthesis_draft_ids: [],
      origin_filename: originFilename,
      origin_file_size: originFileSize,
      origin_content: originText,
      translated_content: mergedText,
      batch_count: resultSegments.length,
      completed_batches: resultSegments.length,
      segments_version: 1,
      completed_at: now,
      updated_at: now,
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  await TranslationSegment.deleteMany({
    translation_file_id: translationFile._id,
    variant: "final",
  });

  await TranslationSegment.insertMany(
    resultSegments.map((segment, index) => {
      const qaEntry = qaMap.get(index);
      const parsedNotes = qaEntry?.notes ?? null;
      const guardFindings = Array.isArray((parsedNotes as any)?.guardFindings)
        ? (parsedNotes as any).guardFindings
        : null;
      return {
        project_id: job.projectId,
        translation_file_id: translationFile._id,
        job_id: job.jobId,
        variant: "final",
        segment_id: segment.segment_id,
        segment_index: index,
        origin_segment: literalMap.get(segment.segment_id) ?? "",
        translation_segment: segment.translation_segment,
        source_draft_ids: [],
        synthesis_notes: {
          guards: qaEntry?.guards ?? null,
          guardFindings,
          backTranslation: qaEntry?.back_translation ?? null,
          needsReview: Boolean(qaEntry?.needs_review),
        },
      };
    }),
  );

  const statusBefore = await query(
    `SELECT status FROM jobs WHERE id = $1`,
    [job.jobId],
  );
  const wasDone = (statusBefore.rows?.[0]?.status ?? "") === "done";

  await query(
    `UPDATE jobs
        SET status = 'done',
            finished_at = NOW(),
            updated_at = NOW()
      WHERE id = $1 AND status != 'cancelled'`,
    [job.jobId],
  );

  const needsReviewCount = qaEntries.filter((row) => row.needs_review === true)
    .length;

  const sceneSummaries = resultSegments.reduce<Record<string, string>>(
    (acc, segment) => {
      acc[segment.segment_id] = segment.translation_segment;
      return acc;
    },
    {},
  );

  try {
    await mergeProjectMemory(job.projectId, {
      scene_summaries: sceneSummaries,
    });
  } catch (error) {
    console.warn("[TRANSLATION] Failed to merge scene summaries into project memory", {
      error,
      projectId: job.projectId,
    });
  }

  return {
    finalized: true,
    translationFileId: translationFile._id.toString(),
    needsReviewCount,
    completedNow: !wasDone,
  };
}

async function loadParagraphIndexMap(jobId: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();

  try {
    const draft = await TranslationDraft.findOne({ job_id: jobId })
      .select({ metadata: 1 })
      .lean();
    const originSegments = (draft?.metadata as any)?.originSegments;
    if (Array.isArray(originSegments)) {
      for (const entry of originSegments) {
        if (!entry) continue;
        const id =
          typeof entry.id === "string"
            ? entry.id
            : typeof entry.segmentId === "string"
              ? entry.segmentId
              : null;
        if (!id) continue;
        const paragraphIndex =
          typeof entry.paragraphIndex === "number"
            ? entry.paragraphIndex
            : typeof entry.paragraph_index === "number"
              ? entry.paragraph_index
              : 0;
        map.set(id, paragraphIndex);
      }
    }
  } catch (error) {
    console.warn(
      "[TRANSLATION] Failed to load paragraph indices from draft metadata",
      { jobId, error },
    );
  }

  return map;
}

function joinWithParagraphs(
  entries: Array<{ text: string; paragraphIndex: number }>,
): string {
  return entries
    .filter((entry) => entry.text.length > 0)
    .reduce((accumulator, current, index, array) => {
      const previous = index > 0 ? array[index - 1] : null;
      const separator = previous
        ? previous.paragraphIndex !== current.paragraphIndex
          ? "\n\n"
          : "\n"
        : "";
      return accumulator + separator + current.text;
    }, "");
}
