import { Types } from "mongoose";
import type { FastifyPluginAsync } from "fastify";
import { requireAuthAndPlanCheck } from "../middleware/auth";
import TranslationFile from "../models/TranslationFile";
import { query } from "../db";

const VALID_STAGES = new Set([
  "literal",
  "style",
  "emotion",
  "qa",
  "draft",
  "revise",
  "micro-check",
]);

type StageDraftRow = {
  segment_id: string | null;
  segment_index: number;
  text_source: string | null;
  text_target: string | null;
  needs_review: boolean | null;
};

type StageDraftQuery = {
  stage?: string;
  jobId?: string | null;
  translationFileId?: string | null;
};

const translationDraftRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/api/projects/:projectId/translations/stage-drafts",
    {
      preHandler: requireAuthAndPlanCheck,
    },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const {
        stage,
        jobId = null,
        translationFileId = null,
      } = request.query as StageDraftQuery;

      if (!stage || !VALID_STAGES.has(stage)) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: "Invalid or missing stage parameter",
        });
      }

      let targetJobId =
        typeof jobId === "string" && jobId.trim().length ? jobId.trim() : null;
      let resolvedTranslationFileId: string | null = null;

      if (!targetJobId && translationFileId) {
        if (!Types.ObjectId.isValid(translationFileId)) {
          return reply.status(400).send({
            code: "VALIDATION_ERROR",
            message: "Invalid translationFileId",
          });
        }

        const translationFile = await TranslationFile.findOne({
          _id: new Types.ObjectId(translationFileId),
          project_id: projectId,
        })
          .lean()
          .exec();

        if (!translationFile) {
          return reply.status(404).send({
            code: "NOT_FOUND",
            message: "Translation file not found",
          });
        }

        resolvedTranslationFileId = translationFile._id.toString();
        targetJobId = translationFile.job_id ?? null;
      }

      if (!targetJobId) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: "jobId or translationFileId is required",
        });
      }

      const availableStagesResult = await query(
        `SELECT stage FROM translation_drafts WHERE project_id = $1 AND job_id = $2 GROUP BY stage`,
        [projectId, targetJobId],
      );
      const availableStages = availableStagesResult.rows
        .map((row) => row.stage)
        .filter((value): value is string => typeof value === "string");

      const { rows } = await query(
        `SELECT segment_id, segment_index, text_source, text_target, needs_review
         FROM translation_drafts
         WHERE project_id = $1 AND job_id = $2 AND stage = $3
         ORDER BY segment_index ASC`,
        [projectId, targetJobId, stage],
      );

      const segments = (rows as StageDraftRow[]).map((row) => ({
        segmentId: row.segment_id ?? `segment-${row.segment_index}`,
        segmentIndex: row.segment_index,
        text: row.text_target ?? "",
        textSource: row.text_source ?? null,
        needsReview: Boolean(row.needs_review),
      }));

      const joinedText = segments
        .map((segment) => segment.text?.trim())
        .filter((value): value is string => Boolean(value && value.length))
        .join("\n\n");

      const needsReviewCount = segments.filter(
        (segment) => segment.needsReview,
      ).length;

      return reply.send({
        projectId,
        jobId: targetJobId,
        translationFileId: resolvedTranslationFileId,
        stage,
        availableStages,
        counts: {
          total: segments.length,
          needsReview: needsReviewCount,
        },
        segments,
        joinedText,
      });
    },
  );
};

export default translationDraftRoutes;
