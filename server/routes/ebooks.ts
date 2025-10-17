import type { FastifyPluginAsync } from "fastify";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import DocumentProfile from "../models/DocumentProfile";
import TranslationFile from "../models/TranslationFile";
import QualityAssessment from "../models/QualityAssessment";
import { requireAuthAndPlanCheck } from "../middleware/auth";
import { query } from "../db";
import { getCoverService } from "../services/cover";
import { generateCoverImageUrl } from "../temp/imageGenAgent";

interface ProjectRow {
  project_id: string;
  user_id: string;
  title: string | null;
  origin_lang: string | null;
  target_lang: string | null;
  meta: any;
}

const ebookStorageRoot =
  process.env.EBOOK_STORAGE_DIR ??
  path.resolve(process.cwd(), "storage", "ebooks");

const ebooksRoutes: FastifyPluginAsync = async (fastify) => {
  const coverService = getCoverService();

  fastify.get(
    "/api/projects/:projectId/cover",
    {
      preHandler: requireAuthAndPlanCheck,
    },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const userId = (request as any).user_id as string | undefined;

      const project = await loadProject(projectId, userId);
      if (!project) {
        return reply.status(404).send({ error: "project_not_found" });
      }

      const overview = await coverService.getCoverOverview(projectId);
      const hasReadyCover = overview.coverSets.some(
        (set) => set.status === "ready",
      );
      const fallbackUrl = hasReadyCover
        ? null
        : generateCoverImageUrl(project.title ?? project.project_id);

      return reply.send({ ...overview, fallbackUrl });
    },
  );

  fastify.post(
    "/api/projects/:projectId/cover/regenerate",
    {
      preHandler: requireAuthAndPlanCheck,
    },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const userId = (request as any).user_id as string | undefined;

      const project = await loadProject(projectId, userId);
      if (!project) {
        return reply.status(404).send({ error: "project_not_found" });
      }

      const translationProfile = await DocumentProfile.findOne({
        project_id: projectId,
        type: "translation",
      })
        .sort({ version: -1 })
        .lean()
        .exec();

      const summary = translationProfile?.summary?.story?.trim();
      if (!summary) {
        return reply.status(409).send({
          error: "summary_unavailable",
          message: "Translation summary is not ready yet.",
        });
      }

      const meta = project.meta ?? {};
      const title = project.title ?? "Untitled Manuscript";
      const author = meta.author ?? meta.writer ?? null;
      const translator = meta.translator ?? null;
      const writerNote = meta.writerNote ?? meta.writer_note ?? null;
      const translatorNote =
        meta.translatorNote ?? meta.translator_note ?? null;
      const isbn = meta.isbn ?? null;

      try {
        const queueResult = await coverService.queueCoverRegeneration({
          projectId,
          title,
          author,
          translator,
          targetLanguage: project.target_lang ?? null,
          summary,
          writerNote,
          translatorNote,
          isbn,
          createdBy: userId ?? null,
          translationProfileId: translationProfile?._id
            ? String(translationProfile._id)
            : null,
        });

        return reply.status(202).send(queueResult);
      } catch (error: any) {
        if (error instanceof Error && error.message === "cover_job_pending") {
          return reply.status(409).send({
            error: "cover_generation_pending",
            message: "A cover regeneration is already in progress.",
          });
        }
        throw error;
      }
    },
  );

  fastify.get(
    "/api/projects/:projectId/cover/image/:assetId",
    {
      preHandler: requireAuthAndPlanCheck,
    },
    async (request, reply) => {
      const { projectId, assetId } = request.params as {
        projectId: string;
        assetId: string;
      };
      const userId = (request as any).user_id as string | undefined;

      const project = await loadProject(projectId, userId);
      if (!project) {
        return reply.status(404).send({ error: "project_not_found" });
      }

      const fileInfo = await coverService.getCoverAssetFile(projectId, assetId);
      if (!fileInfo) {
        return reply.status(404).send({ error: "cover_not_found" });
      }

      try {
        const stats = await stat(fileInfo.absolutePath);
        reply.header("Content-Type", fileInfo.mimeType ?? "image/jpeg");
        reply.header("Content-Length", stats.size);
        return reply.send(createReadStream(fileInfo.absolutePath));
      } catch (error) {
        fastify.log.error(
          { err: error, projectId, assetId },
          "[COVER] Failed to stream cover image",
        );
        return reply.status(500).send({ error: "cover_stream_failed" });
      }
    },
  );

  fastify.get(
    "/api/projects/:projectId/ebook/download/:assetId",
    {
      preHandler: requireAuthAndPlanCheck,
    },
    async (request, reply) => {
      const { projectId, assetId } = request.params as {
        projectId: string;
        assetId: string;
      };
      const userId = (request as any).user_id as string | undefined;

      const project = await loadProject(projectId, userId);
      if (!project) {
        return reply.status(404).send({ error: "project_not_found" });
      }

      const assetRes = await query(
        `SELECT file_path, mime_type, file_name
           FROM ebook_assets
          WHERE project_id = $1
            AND ebook_asset_id = $2
            AND asset_type = 'manuscript'
          LIMIT 1;`,
        [projectId, assetId],
      );
      const assetRow = assetRes.rows[0];
      if (!assetRow) {
        return reply.status(404).send({ error: "manuscript_not_found" });
      }

      const absolutePath = path.join(
        ebookStorageRoot,
        assetRow.file_path as string,
      );

      try {
        const stats = await stat(absolutePath);
        const downloadName = assetRow.file_name ?? "ebook";
        reply.header(
          "Content-Type",
          assetRow.mime_type ?? "application/octet-stream",
        );
        reply.header("Content-Length", stats.size);
        reply.header(
          "Content-Disposition",
          `attachment; filename="${downloadName}"`,
        );
        return reply.send(createReadStream(absolutePath));
      } catch (error) {
        fastify.log.error(
          { err: error, projectId, assetId },
          "[EBOOK] Failed to stream manuscript asset",
        );
        return reply.status(500).send({ error: "ebook_stream_failed" });
      }
    },
  );

  fastify.get(
    "/api/projects/:projectId/ebook",
    {
      preHandler: requireAuthAndPlanCheck,
    },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const userId = (request as any).user_id as string | undefined;

      const project = await loadProject(projectId, userId);
      if (!project) {
        return reply.status(404).send({ error: "project_not_found" });
      }

      const ebookRes = await query(
        `SELECT * FROM ebooks WHERE project_id = $1 LIMIT 1`,
        [projectId],
      );
      const ebookRow = ebookRes.rows[0];

      if (!ebookRow) {
        return reply.send({ projectId, status: "missing", ebook: null });
      }

      const [versionRes, metadataRes, distributionRes] = await Promise.all([
        query(
          `SELECT *
             FROM ebook_versions
            WHERE ebook_id = $1
            ORDER BY version_number DESC
            LIMIT 1`,
          [ebookRow.ebook_id],
        ),
        query(
          `SELECT writer_note, translator_note, isbn
             FROM ebook_metadata
            WHERE ebook_id = $1
            LIMIT 1`,
          [ebookRow.ebook_id],
        ),
        query(
          `SELECT channel, status, listing_id, price, currency, planned_publish_at, published_at, last_synced_at, failure_reason
             FROM ebook_distribution_channels
            WHERE ebook_id = $1`,
          [ebookRow.ebook_id],
        ),
      ]);

      const latestVersion = versionRes.rows[0];
      let manuscriptAsset: any = null;
      if (latestVersion) {
        const assetRes = await query(
          `SELECT *
             FROM ebook_assets
            WHERE ebook_version_id = $1
              AND asset_type = 'manuscript'
              AND is_current = TRUE
            LIMIT 1`,
          [latestVersion.ebook_version_id],
        );
        manuscriptAsset = assetRes.rows[0] ?? null;
      }

      return reply.send({
        projectId,
        status: ebookRow.status ?? "draft",
        ebook: {
          ebookId: ebookRow.ebook_id,
          title: ebookRow.title,
          author: ebookRow.author,
          translator: ebookRow.translator,
          synopsis: ebookRow.synopsis,
          sourceLanguage: ebookRow.source_language,
          targetLanguage: ebookRow.target_language,
          createdAt: ebookRow.created_at,
          updatedAt: ebookRow.updated_at,
          currentVersionId: ebookRow.current_version_id,
        },
        metadata: {
          writerNote: metadataRes.rows[0]?.writer_note ?? null,
          translatorNote: metadataRes.rows[0]?.translator_note ?? null,
          isbn: metadataRes.rows[0]?.isbn ?? null,
        },
        latestVersion: latestVersion
          ? {
              ebookVersionId: latestVersion.ebook_version_id,
              versionNumber: latestVersion.version_number,
              translationFileId: latestVersion.translation_file_id,
              qualityAssessmentId: latestVersion.quality_assessment_id,
              format: latestVersion.export_format,
              wordCount: latestVersion.word_count,
              characterCount: latestVersion.character_count,
              createdAt: latestVersion.created_at,
              createdBy: latestVersion.created_by,
              asset: manuscriptAsset
                ? {
                    assetId: manuscriptAsset.ebook_asset_id,
                    fileName: manuscriptAsset.file_name,
                    publicUrl: manuscriptAsset.public_url,
                    mimeType: manuscriptAsset.mime_type,
                    filePath: manuscriptAsset.file_path,
                    sizeBytes: manuscriptAsset.size_bytes,
                    checksum: manuscriptAsset.checksum,
                  }
                : null,
            }
          : null,
        distribution: distributionRes.rows,
      });
    },
  );

  fastify.get(
    "/api/projects/:projectId/translations",
    {
      preHandler: requireAuthAndPlanCheck,
    },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const userId = (request as any).user_id as string | undefined;

      const project = await loadProject(projectId, userId);
      if (!project) {
        return reply.status(404).send({ error: "project_not_found" });
      }

      const translations = await TranslationFile.find({ project_id: projectId })
        .sort({ completed_at: -1, updated_at: -1 })
        .lean()
        .exec();

      if (!translations.length) {
        return reply.send([]);
      }

      const qualityDocs = await QualityAssessment.find({ projectId })
        .sort({ timestamp: -1 })
        .lean()
        .exec();

      const qualityByJob = new Map<string, any>();
      for (const qa of qualityDocs) {
        const jobId = (qa as any).jobId ?? (qa as any).job_id;
        if (jobId && !qualityByJob.has(jobId)) {
          qualityByJob.set(jobId, qa);
        }
      }

      const response = translations.map((tf: any) => {
        const jobId = tf.job_id ?? tf.jobId ?? null;
        const qa = jobId ? (qualityByJob.get(jobId) ?? null) : null;
        const qualityScore = qa?.qualityResult?.overallScore ?? null;

        return {
          translationFileId: String(tf._id ?? tf.id),
          filename: typeof tf.filename === "string" ? tf.filename : null,
          jobId,
          createdAt: tf.created_at
            ? new Date(tf.created_at).toISOString()
            : tf.createdAt
              ? new Date(tf.createdAt).toISOString()
              : null,
          updatedAt: tf.updated_at
            ? new Date(tf.updated_at).toISOString()
            : tf.updatedAt
              ? new Date(tf.updatedAt).toISOString()
              : null,
          completedAt: tf.completed_at
            ? new Date(tf.completed_at).toISOString()
            : null,
          qualityScore,
          qualityAssessmentId: qa?.assessmentId ?? qa?._id ?? null,
        };
      });

      return reply.send(response);
    },
  );
};

async function loadProject(projectId: string, userId?: string) {
  const sql = `
    SELECT project_id, user_id, title, origin_lang, target_lang, meta
      FROM translationprojects
     WHERE project_id = $1
       AND ($2::text IS NULL OR user_id = $2)
     LIMIT 1;
  `;

  const result = await query(sql, [projectId, userId ?? null]);
  const row = result.rows[0] as ProjectRow | undefined;
  if (!row) return null;

  let meta: Record<string, any> = {};
  if (row.meta) {
    if (typeof row.meta === "string") {
      try {
        meta = JSON.parse(row.meta);
      } catch (error) {
        meta = {};
      }
    } else if (typeof row.meta === "object") {
      meta = row.meta as Record<string, any>;
    }
  }

  return { ...row, meta };
}

export default ebooksRoutes;
