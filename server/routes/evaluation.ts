// routes/evaluation.ts
import { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import {
  evaluateQuality,
  type FinalEvaluation,
  type QualityEvaluationEvent,
} from "../agents/qualityAgent";
import { requireAuthAndPlanCheck } from "../middleware/auth";
import { nanoid } from "nanoid";
import QualityAssessment from "../models/QualityAssessment";
import mongoose from "mongoose";
import TranslationFile from "../models/TranslationFile";
import OriginFile from "../models/OriginFile";
import TranslationBatch from "../models/TranslationBatch";
import Proofreading from "../models/Proofreading";
import DocumentProfile, {
  normalizeTranslationNotes,
} from "../models/DocumentProfile";
import { query } from "../db";
import { recordTokenUsage } from "../services/usage";
import {
  requestAction as requestWorkflowAction,
  completeAction as completeWorkflowRun,
  failAction as failWorkflowRun,
  WorkflowRunRecord,
} from "../services/workflowManager";
import { loadOriginPrepSnapshot } from "../services/originPrep";

// ---------- helpers ----------
function getUserId(request: FastifyRequest): string | null {
  const anyReq = request as any;
  return anyReq?.user?.user_id ?? anyReq?.user_id ?? null;
}

function ok<T>(reply: FastifyReply, data: T) {
  return reply.send({ success: true, data });
}

function fail(reply: FastifyReply, status: number, message: string) {
  return reply.status(status).send({ success: false, error: message });
}

function serializeDocumentProfile(doc: any) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    projectId: doc.project_id,
    type: doc.type,
    version: doc.version,
    language: doc.language ?? null,
    jobId: doc.job_id ?? null,
    metrics: doc.metrics,
    summary: doc.summary,
    references: {
      originFileId: doc.origin_file_id ? String(doc.origin_file_id) : null,
      translationFileId: doc.translation_file_id
        ? String(doc.translation_file_id)
        : null,
      qualityAssessmentId: doc.quality_assessment_id
        ? String(doc.quality_assessment_id)
        : null,
      proofreadingId: doc.proofreading_id ? String(doc.proofreading_id) : null,
    },
    translationNotes: normalizeTranslationNotes(doc.translation_notes ?? null),
    source: {
      hash: doc.source_hash ?? null,
      preview: doc.source_preview ?? null,
    },
    createdAt: doc.created_at ?? doc.createdAt ?? null,
    updatedAt: doc.updated_at ?? doc.updatedAt ?? null,
  };
}

function handleError(
  req: FastifyRequest,
  reply: FastifyReply,
  err: unknown,
  msg: string,
) {
  req.log.error(err);
  return fail(reply, 500, msg);
}

async function enqueueTranslationProfileJob({
  projectId,
  userId,
  payload,
}: {
  projectId: string;
  userId: string;
  payload: Record<string, unknown>;
}) {
  const documentId = JSON.stringify({
    ...payload,
    requestedAt: payload.requestedAt ?? new Date().toISOString(),
  });
  const id = nanoid();
  await query(
    `INSERT INTO jobs (id, user_id, document_id, type, status, created_at, attempts, project_id, created_by, updated_at, updated_by, workflow_run_id)
     VALUES ($1, $2, $3, $4, $5, now(), 0, $6, $7, $8, $9, $10)`,
    [
      id,
      userId,
      documentId,
      "profile",
      "queued",
      projectId,
      userId,
      null,
      userId,
      null,
    ],
  );
}

// ---------- stub services (실DB 연결시 이 내부만 교체) ----------
function parseProjectMemo(rawMemo: string | null) {
  const memo = rawMemo ?? "";
  const lines = memo
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  let author: string | null = null;
  let context: string | null = null;
  const rest: string[] = [];

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.startsWith("author:")) {
      author = line.slice(7).trim() || null;
    } else if (lower.startsWith("context:")) {
      context = line.slice(8).trim() || null;
    } else {
      rest.push(line);
    }
  }

  return {
    author,
    context,
    notes: rest.join("\n") || null,
  };
}

async function loadProjectProfile(projectId: string, userId: string) {
  try {
    const { rows } = await query(
      `SELECT project_id, user_id, title, description, intention, book_title, author_name, translator_name, memo, meta, status, origin_lang, target_lang, created_at, updated_at
         FROM translationprojects
         WHERE project_id = $1 AND user_id = $2
         LIMIT 1`,
      [projectId, userId],
    );

    if (!rows || rows.length === 0) return null;
    const row = rows[0];
    const parsed = parseProjectMemo(row.memo ?? null);
    let storedMeta: any = {};
    if (row.meta) {
      if (typeof row.meta === "object") storedMeta = row.meta;
      else {
        try {
          storedMeta = JSON.parse(row.meta);
        } catch (err) {
          storedMeta = {};
        }
      }
    }

    const authorName = row.author_name ?? storedMeta.author ?? parsed.author;
    const translatorName = row.translator_name ?? storedMeta.translator ?? null;

    return {
      id: row.project_id,
      title: row.title,
      status: row.status,
      description: row.description,
      intention: row.intention,
      bookTitle: row.book_title ?? row.title ?? null,
      authorName,
      translatorName,
      memo: row.memo,
      originLang: row.origin_lang,
      targetLang: row.target_lang,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      meta: {
        author: authorName,
        context:
          storedMeta.context ?? parsed.context ?? row.description ?? null,
        notes: storedMeta.notes ?? parsed.notes,
        translationDirection: storedMeta.translationDirection ?? row.intention,
        draftTitle: storedMeta.draftTitle ?? null,
      },
    };
  } catch (e) {
    return {
      id: projectId,
      title: `Project ${projectId}`,
      status: "unknown",
      description: null,
      intention: null,
      bookTitle: null,
      authorName: null,
      translatorName: null,
      memo: null,
      originLang: null,
      targetLang: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      meta: {
        author: null,
        translator: null,
        context: null,
        notes: null,
        translationDirection: null,
      },
    };
  }
}

async function loadLatestJob(projectId: string, _userId: string) {
  // Get latest *translation* job entry from PostgreSQL jobs table by project id
  try {
    const { rows } = await query(
      `SELECT id as job_id, created_at, updated_at, status, type
         FROM jobs
         WHERE project_id = $1 AND type = 'translate'
         ORDER BY created_at DESC
         LIMIT 1`,
      [projectId],
    );
    if (!rows || rows.length === 0) return null;
    const job = rows[0];

    // get batches for the job (include origin/translated text if present in Postgres table)
    const { rows: batchRows } = await query(
      `SELECT id, batch_index, status, started_at, finished_at, error, mongo_batch_id FROM translation_batches WHERE job_id = $1 ORDER BY batch_index`,
      [job.job_id],
    );

    // Map batches
    const batches = (batchRows || []).map((b: any) => ({
      batchId: b.id,
      index: b.batch_index,
      status: b.status,
      startedAt: b.started_at,
      finishedAt: b.finished_at,
      error: b.error,
      mongoBatchId: b.mongo_batch_id || null,
    }));

    return {
      jobId: job.job_id,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
      status: job.status,
      type: job.type,
      batchCount: batches.length,
      completedBatchCount: batches.filter((x: any) => x.status === "done")
        .length,
      errorBatchCount: batches.filter((x: any) => x.status === "failed").length,
      batches,
    };
  } catch (e) {
    return null;
  }
}

async function loadContent(projectId: string, _userId: string, jobId?: string) {
  // Load latest translation file document from MongoDB
  try {
    // Prefer translation_files by project+job if jobId provided
    let tf: any = null;
    if (jobId) {
      tf = await TranslationFile.findOne({
        project_id: projectId,
        job_id: jobId,
      })
        .lean()
        .exec();
      if (!tf) {
        tf = await TranslationFile.findOne({ job_id: jobId }).lean().exec();
      }
      if (tf && tf.project_id !== projectId) {
        try {
          await TranslationFile.updateOne(
            { _id: tf._id },
            { project_id: projectId },
          );
          tf.project_id = projectId;
        } catch (err) {
          console.warn(
            "[CONTENT] Failed to backfill project_id on translation file",
            {
              err,
              projectId,
              jobId,
            },
          );
        }
      }
    }
    if (!tf) {
      tf = await TranslationFile.findOne({ project_id: projectId })
        .sort({ updated_at: -1, completed_at: -1 })
        .lean()
        .exec();
    }

    if (!tf) {
      let originDocFallback: any = null;
      try {
        originDocFallback = await OriginFile.findOne({ project_id: projectId })
          .sort({ updated_at: -1 })
          .lean()
          .exec();
      } catch (err) {
        originDocFallback = null;
      }

      if (!originDocFallback) {
        return { origin: null, translation: null };
      }

      return {
        origin: {
          content: originDocFallback.text_content ?? "",
          timestamp:
            originDocFallback.updated_at ??
            originDocFallback.created_at ??
            null,
          language: originDocFallback.language ?? null,
          fileName: originDocFallback.original_filename ?? null,
        },
        translation: null,
        meta: null,
        proofreading: null,
      };
    }

    const proofCol = mongoose.connection?.db?.collection("proofreading_files");
    let proofDoc: any = null;
    if (proofCol) {
      const proofQuery: Record<string, any> = { project_id: projectId };
      if (jobId) proofQuery.job_id = jobId;
      proofDoc = await proofCol
        .find(proofQuery)
        .sort({ updated_at: -1 })
        .limit(1)
        .next();
    }

    const appliedTranslation = proofDoc?.applied_translated_content;
    const translationContent =
      appliedTranslation || tf.translated_content || "";
    const originTimestamp = tf.updated_at ?? tf.completed_at ?? null;

    return {
      origin: {
        content: tf.origin_content,
        timestamp: originTimestamp,
        language: null,
        fileName: tf.origin_filename,
      },
      translation: {
        content: translationContent,
        timestamp: tf.updated_at ?? tf.completed_at ?? null,
        language: null,
        method: tf.translation_method || "N/A",
        isPartial: tf.completed_batches < tf.batch_count,
        jobId: tf.job_id,
        translationFileId: tf._id ? String(tf._id) : null,
      },
      meta: {
        batch_count: tf.batch_count,
        completed_batches: tf.completed_batches,
      },
      proofreading: proofDoc
        ? {
            id: proofDoc.proofreading_id,
            appliedIssueIds: proofDoc.applied_issue_ids ?? [],
            report: proofDoc.report ?? null,
            quickReport: proofDoc.quick_report ?? null,
            deepReport: proofDoc.deep_report ?? null,
            appliedTranslation: appliedTranslation ?? null,
            updatedAt: proofDoc.updated_at ?? proofDoc.created_at,
          }
        : null,
    };
  } catch (e) {
    return { origin: null, translation: null };
  }
}

async function loadLatestQuality(
  projectId: string,
  userId: string,
  jobId?: string,
) {
  // Prefer job-scoped quality assessment when jobId present
  let q: any = null;
  try {
    if (jobId) {
      q = await QualityAssessment.findOne({ projectId, jobId })
        .sort({ timestamp: -1 })
        .lean()
        .exec();
      if (q) return q;
    }
  } catch (e) {
    // ignore and fallback
  }

  try {
    q = await QualityAssessment.findOne({ projectId, userId })
      .sort({ timestamp: -1 })
      .lean()
      .exec();
    return q ?? null;
  } catch (e) {
    return null;
  }
}

async function loadProofreading(projectId: string, jobId?: string) {
  try {
    const mongo = mongoose.connection?.db;
    if (!mongo) return null;

    const collection = mongo.collection("proofreading_files");
    const query: Record<string, any> = { project_id: projectId };
    if (jobId) query.job_id = jobId;

    const doc = await collection
      .find(query)
      .sort({ updated_at: -1, created_at: -1 })
      .limit(1)
      .next();

    return doc ?? null;
  } catch (e) {
    return null;
  }
}

async function loadQualityHistory(projectId: string, userId: string) {
  // Return all assessments for the project across jobs/users so trend charts reflect project-wide history
  const items = await QualityAssessment.find({ projectId })
    .sort({ timestamp: 1 })
    .select("timestamp qualityResult assessmentId")
    .lean()
    .exec();

  return items.map((a: any, i: number) => ({
    assessmentId: a.assessmentId,
    timestamp: a.timestamp,
    assessmentNumber: i + 1,
    overallScore: a.qualityResult?.overallScore ?? 0,
    quantitative: a.qualityResult?.quantitative
      ? {
          fidelity: a.qualityResult.quantitative?.Fidelity?.score ?? 0,
          fluency: a.qualityResult.quantitative?.Fluency?.score ?? 0,
          literaryStyle:
            a.qualityResult.quantitative?.["Literary Style"]?.score ?? 0,
          culturalResonance:
            a.qualityResult.quantitative?.["Cultural Resonance"]?.score ?? 0,
          creativeAutonomy:
            a.qualityResult.quantitative?.["Creative Autonomy"]?.score ?? 0,
        }
      : null,
  }));
}

async function loadEbookSummary(projectId: string) {
  try {
    const ebookRes = await query(
      `SELECT ebook_id, status, updated_at
         FROM ebooks
        WHERE project_id = $1
        ORDER BY updated_at DESC NULLS LAST, created_at DESC
        LIMIT 1`,
      [projectId],
    );

    if (!ebookRes.rows.length) {
      return null;
    }

    const ebookRow = ebookRes.rows[0];
    const ebookId = ebookRow.ebook_id as string;

    const versionRes = await query(
      `SELECT ebook_version_id, version_number, export_format, created_at, updated_at
         FROM ebook_versions
        WHERE ebook_id = $1
        ORDER BY version_number DESC
        LIMIT 1`,
      [ebookId],
    );
    const versionRow = versionRes.rows[0] ?? null;

    let assetRow: any = null;
    if (versionRow) {
      const assetRes = await query(
        `SELECT ebook_asset_id, file_name, public_url, mime_type, file_path, size_bytes, checksum, updated_at
           FROM ebook_assets
          WHERE ebook_version_id = $1
            AND asset_type = 'manuscript'
            AND is_current = TRUE
          LIMIT 1`,
        [versionRow.ebook_version_id],
      );
      assetRow = assetRes.rows[0] ?? null;
    }

    const updatedAt =
      ebookRow.updated_at?.toISOString?.() ??
      versionRow?.updated_at?.toISOString?.() ??
      versionRow?.created_at?.toISOString?.() ??
      null;

    return {
      ebookId,
      status: ebookRow.status ?? "unknown",
      updatedAt,
      format: versionRow?.export_format ?? null,
      filename: assetRow?.file_name ?? null,
      storageRef: assetRow?.public_url ?? null,
      assetId: assetRow?.ebook_asset_id ?? null,
      versionId: versionRow?.ebook_version_id ?? null,
    };
  } catch (error) {
    return null;
  }
}

// ---------- plugin ----------
const evaluationRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /api/evaluate/stream
  fastify.post(
    "/api/evaluate/stream",
    {
      preHandler: requireAuthAndPlanCheck,
      schema: {
        body: {
          type: "object",
          required: ["source", "translated"],
          properties: {
            source: { type: "string" },
            translated: { type: "string" },
            authorIntention: { type: "string" },
            model: { type: "string" },
            maxCharsPerChunk: { type: "number" },
            overlap: { type: "number" },
            projectId: { type: "string" },
            jobId: { type: "string" },
            workflowLabel: { type: "string" },
            workflowAllowParallel: { type: "boolean" },
            concurrency: { type: "number" },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = getUserId(request);
      const body = request.body as {
        source: string;
        translated: string;
        authorIntention?: string;
        model?: string;
        maxCharsPerChunk?: number;
        overlap?: number;
        projectId?: string;
        jobId?: string;
        workflowLabel?: string;
        workflowAllowParallel?: boolean;
        concurrency?: number;
      };

      let workflowRun: WorkflowRunRecord | null = null;

      if (body.projectId) {
        try {
          const wfResult = await requestWorkflowAction({
            projectId: body.projectId,
            type: "quality",
            requestedBy: userId,
            label: body.workflowLabel ?? null,
            metadata: {
              jobId: body.jobId ?? null,
              source: "quality.evaluate.stream",
            },
            allowParallel: Boolean(body.workflowAllowParallel),
          });

          if (!wfResult.accepted || !wfResult.run) {
            return fail(
              reply,
              409,
              "해당 프로젝트에서는 품질 검토를 실행할 수 없습니다.",
            );
          }

          workflowRun = wfResult.run;
        } catch (workflowError) {
          return handleError(
            request,
            reply,
            workflowError,
            "품질 검토 워크플로우를 준비하지 못했습니다",
          );
        }
      }

      reply.hijack();
      reply.raw.statusCode = 200;
      reply.raw.setHeader(
        "Content-Type",
        "application/x-ndjson; charset=utf-8",
      );
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.setHeader("Transfer-Encoding", "chunked");

      let streamClosed = false;
      request.raw.once("close", () => {
        streamClosed = true;
      });

      const flush = () => {
        const raw = reply.raw as any;
        if (typeof raw.flush === "function") {
          try {
            raw.flush();
          } catch (err) {
            request.log.trace(
              { err },
              "[QUALITY] Failed to flush NDJSON response",
            );
          }
        }
      };

      const send = (payload: Record<string, unknown>) => {
        if (streamClosed) return;
        try {
          reply.raw.write(`${JSON.stringify(payload)}\n`);
          flush();
        } catch (err) {
          streamClosed = true;
          request.log.warn(
            { err },
            "[QUALITY] Failed to write NDJSON chunk",
          );
        }
      };

      const serializeEvent = (event: QualityEvaluationEvent) => {
        if (event.type === "chunk-error") {
          return {
            ...event,
            error:
              event.error instanceof Error
                ? {
                    name: event.error.name,
                    message: event.error.message,
                  }
                : event.error ?? null,
          };
        }
        return event;
      };

      let finalResult: FinalEvaluation | null = null;

      const sendEvent = (event: QualityEvaluationEvent) => {
        if (event.type === "complete") {
          finalResult = event.result;
        }
        send(serializeEvent(event));
      };

      try {
        const result = await evaluateQuality(
          {
            source: body.source,
            translated: body.translated,
            authorIntention: body.authorIntention,
            model: body.model,
            maxCharsPerChunk: body.maxCharsPerChunk,
            overlap: body.overlap,
            projectId: body.projectId,
            jobId: body.jobId,
          },
          {
            concurrency:
              typeof body.concurrency === "number" && body.concurrency > 0
                ? body.concurrency
                : undefined,
            listeners: {
              onEvent: async (event) => {
                sendEvent(event);
              },
            },
          },
        );

        if (!finalResult) {
          finalResult = result;
          sendEvent({ type: "complete", result });
        }

        const tokens = finalResult.meta?.tokens;
        if ((body.projectId || body.jobId) && tokens) {
          await recordTokenUsage(request.log, {
            project_id: body.projectId,
            job_id: body.jobId,
            event_type: "quality",
            model: finalResult.meta.model,
            input_tokens: tokens.input,
            output_tokens: tokens.output,
          });
        }

        if (workflowRun) {
          await completeWorkflowRun(workflowRun.runId, {
            jobId: body.jobId ?? null,
            score: finalResult.overallScore,
          });
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err ?? "Unknown error");
        request.log.error({ err }, "[QUALITY] Streamed evaluation failed");
        try {
          send({ type: "error", message });
        } catch (writeErr) {
          request.log.warn(
            { err: writeErr },
            "[QUALITY] Failed to send error event",
          );
        }

        if (workflowRun) {
          try {
            await failWorkflowRun(workflowRun.runId, {
              jobId: body.jobId ?? null,
              error: message,
            });
          } catch (workflowError) {
            request.log.warn(
              { err: workflowError, runId: workflowRun.runId },
              "[QUALITY] Failed to mark workflow run failure",
            );
          }
        }
      } finally {
        try {
          reply.raw.end();
        } catch (endErr) {
          request.log.trace(
            { err: endErr },
            "[QUALITY] Failed to close NDJSON stream",
          );
        }
      }
    },
  );

  // POST /api/evaluate
  fastify.post(
    "/api/evaluate",
    {
      preHandler: requireAuthAndPlanCheck,
      schema: {
        body: {
          type: "object",
          required: ["source", "translated"],
          properties: {
            source: { type: "string" },
            translated: { type: "string" },
            authorIntention: { type: "string" },
            model: { type: "string" },
            maxCharsPerChunk: { type: "number" },
            overlap: { type: "number" },
            projectId: { type: "string" },
            jobId: { type: "string" },
            workflowLabel: { type: "string" },
            workflowAllowParallel: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      let workflowRun: WorkflowRunRecord | null = null;
      try {
        const userId = getUserId(request);
        const body = request.body as {
          source: string;
          translated: string;
          authorIntention?: string;
          model?: string;
          maxCharsPerChunk?: number;
          overlap?: number;
          projectId?: string;
          jobId?: string;
          workflowLabel?: string;
          workflowAllowParallel?: boolean;
        };

        if (body.projectId) {
          try {
            const wfResult = await requestWorkflowAction({
              projectId: body.projectId,
              type: "quality",
              requestedBy: userId,
              label: body.workflowLabel ?? null,
              metadata: {
                jobId: body.jobId ?? null,
                source: "quality.evaluate",
              },
              allowParallel: Boolean(body.workflowAllowParallel),
            });
            if (!wfResult.accepted || !wfResult.run) {
              return fail(
                reply,
                409,
                "해당 프로젝트에서는 품질 검토를 실행할 수 없습니다.",
              );
            }
            workflowRun = wfResult.run;
          } catch (workflowError) {
            return handleError(
              request,
              reply,
              workflowError,
              "품질 검토 워크플로우를 준비하지 못했습니다",
            );
          }
        }

        const result = await evaluateQuality({
          source: body.source,
          translated: body.translated,
          authorIntention: body.authorIntention,
          model: body.model,
          maxCharsPerChunk: body.maxCharsPerChunk,
          overlap: body.overlap,
          projectId: body.projectId,
          jobId: body.jobId,
        });

        const tokens = result.meta?.tokens;
        if ((body.projectId || body.jobId) && tokens) {
          await recordTokenUsage(request.log, {
            project_id: body.projectId,
            job_id: body.jobId,
            event_type: "quality",
            model: result.meta.model,
            input_tokens: tokens.input,
            output_tokens: tokens.output,
          });
        }

        if (workflowRun) {
          await completeWorkflowRun(workflowRun.runId, {
            jobId: body.jobId ?? null,
            score: result.overallScore,
          });
        }

        return ok(reply, result);
      } catch (err) {
        if (workflowRun) {
          try {
            await failWorkflowRun(workflowRun.runId, {
              error: err instanceof Error ? err.message : String(err),
            });
          } catch (workflowError) {
            request.log.warn(
              { err: workflowError, runId: workflowRun.runId },
              "[QUALITY] Failed to mark workflow run failure",
            );
          }
        }
        return handleError(request, reply, err, "Evaluation failed");
      }
    },
  );

  // POST /api/quality/save
  fastify.post(
    "/api/quality/save",
    {
      preHandler: requireAuthAndPlanCheck,
      schema: {
        body: {
          type: "object",
          required: [
            "projectId",
            "sourceText",
            "translatedText",
            "qualityResult",
          ],
          properties: {
            projectId: { type: "string" },
            jobId: { type: "string" },
            sourceText: { type: "string" },
            translatedText: { type: "string" },
            qualityResult: { type: "object" },
            translationMethod: { type: "string", enum: ["auto", "manual"] },
            modelUsed: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const userId = getUserId(request);
        if (!userId) return fail(reply, 401, "User not authenticated");

        const body = request.body as {
          projectId: string;
          jobId?: string;
          sourceText: string;
          translatedText: string;
          qualityResult: any;
          translationMethod?: "auto" | "manual";
          modelUsed?: string;
        };

        const assessmentId = nanoid();
        const saved = await QualityAssessment.create({
          projectId: body.projectId,
          jobId: body.jobId,
          assessmentId,
          timestamp: new Date(),
          sourceText: body.sourceText,
          translatedText: body.translatedText,
          qualityResult: body.qualityResult,
          translationMethod: body.translationMethod ?? "auto",
          modelUsed: body.modelUsed ?? "gpt-4o-mini",
          userId,
        });

        return ok(reply, {
          assessmentId,
          id: saved._id,
          message: "Quality assessment saved successfully",
        });
      } catch (err) {
        return handleError(
          request,
          reply,
          err,
          "Failed to save quality assessment",
        );
      }
    },
  );

  // GET /api/quality/:projectId/latest
  fastify.get(
    "/api/quality/:projectId/latest",
    {
      preHandler: requireAuthAndPlanCheck,
      schema: {
        params: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      try {
        const { projectId } = request.params as { projectId: string };
        const userId = getUserId(request);
        if (!userId) return fail(reply, 401, "User not authenticated");

        const latest = await loadLatestQuality(projectId, userId);
        if (!latest)
          return fail(
            reply,
            404,
            "No quality assessment found for this project",
          );

        return ok(reply, { assessment: latest });
      } catch (err) {
        return handleError(
          request,
          reply,
          err,
          "Failed to retrieve quality assessment",
        );
      }
    },
  );

  // GET /api/quality/:projectId/history
  fastify.get(
    "/api/quality/:projectId/history",
    {
      preHandler: requireAuthAndPlanCheck,
      schema: {
        params: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      try {
        const { projectId } = request.params as { projectId: string };
        const userId = getUserId(request);
        if (!userId) return fail(reply, 401, "User not authenticated");

        const assessments = await loadQualityHistory(projectId, userId);
        return ok(reply, { assessments });
      } catch (err) {
        return handleError(
          request,
          reply,
          err,
          "Failed to retrieve quality history",
        );
      }
    },
  );

  // GET /api/project/:projectId/latestContent  (canonical)
  fastify.get(
    "/api/project/:projectId/latestContent",
    {
      preHandler: requireAuthAndPlanCheck,
      schema: {
        params: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      try {
        const { projectId } = request.params as { projectId: string };
        const userId = getUserId(request);
        if (!userId) return fail(reply, 401, "User not authenticated");

        const projectProfile = await loadProjectProfile(projectId, userId);
        let latestJob = await loadLatestJob(projectId, userId);
        const content = await loadContent(projectId, userId, latestJob?.jobId);

        // load origin_files (Mongo) as primary origin source
        let originDoc: any = null;
        try {
          originDoc = await OriginFile.findOne({ project_id: projectId })
            .sort({ updated_at: -1 })
            .lean()
            .exec();
        } catch (e) {
          originDoc = null;
        }

        // load batches (Postgres) with origin/translated text (metadata)
        let batches: any[] = [];
        // and load actual batch documents from Mongo (actual data)
        let mongoBatchDocs: any[] = [];
        try {
          // Determine jobId to query: prefer latestJob.jobId, fallback to translation file's jobId
          const deducedJobId =
            latestJob?.jobId ||
            (content.translation && content.translation.jobId) ||
            null;

          if (deducedJobId) {
            // Query Postgres metadata for that jobId
            try {
              const { rows } = await query(
                `SELECT id, batch_index, status, mongo_batch_id, started_at, finished_at, error FROM translation_batches WHERE job_id = $1 ORDER BY batch_index`,
                [deducedJobId],
              );
              batches = (rows || []).map((r: any) => ({
                batchId: r.id,
                batch_index: r.batch_index,
                batch_status: r.status,
                index: r.batch_index,
                status: r.status,
                mongoBatchId: r.mongo_batch_id || null,
                startedAt: r.started_at,
                finishedAt: r.finished_at,
                error: r.error,
              }));
            } catch (err) {
              batches = [];
            }

            // Also fetch Mongo translation batch documents (if any) for the same job
            try {
              mongoBatchDocs = await TranslationBatch.find({
                job_id: deducedJobId,
              })
                .sort({ batch_index: 1 })
                .lean()
                .exec();
            } catch (e) {
              mongoBatchDocs = [];
            }

            // If latestJob was null but we found a deducedJobId, set a minimal latestJob summary
            if (!latestJob) {
              latestJob = {
                jobId: deducedJobId,
                createdAt: null,
                updatedAt: null,
                status: "unknown",
                type: "translate",
                batchCount: batches.length,
                completedBatchCount: batches.filter(
                  (x: any) => x.status === "done",
                ).length,
                errorBatchCount: batches.filter(
                  (x: any) => x.status === "failed",
                ).length,
                batches,
              } as any;
            }
          }
        } catch (e) {
          batches = [];
          mongoBatchDocs = [];
        }

        // If origin not found in origin_files, fallback to batches[0].originText
        if (!originDoc && batches.length > 0 && batches[0].originText) {
          originDoc = {
            origin_content: batches[0].originText,
            updated_at: batches[0].startedAt,
          };
        }

        // load quality by jobId first
        const qualityAssessment = await loadLatestQuality(
          projectId,
          userId,
          latestJob?.jobId,
        );

        // load proofreading
        const proofreadingDoc: any = await loadProofreading(
          projectId,
          latestJob?.jobId,
        );

        const proofreading = proofreadingDoc
          ? {
              exists: true,
              stage: proofreadingDoc.status || proofreadingDoc.stage || "done",
              id: proofreadingDoc.proofreading_id || proofreadingDoc._id,
              jobId: proofreadingDoc.job_id,
              applied: Boolean(
                proofreadingDoc.applied_issue_ids &&
                  proofreadingDoc.applied_issue_ids.length,
              ),
              appliedIssueIds: proofreadingDoc.applied_issue_ids ?? [],
              appliedTranslation:
                proofreadingDoc.applied_translated_content ??
                proofreadingDoc.translated_text ??
                null,
              report: proofreadingDoc.report ?? null,
              quickReport: proofreadingDoc.quick_report ?? null,
              deepReport: proofreadingDoc.deep_report ?? null,
              timestamp:
                proofreadingDoc.updated_at || proofreadingDoc.created_at,
            }
          : { exists: false, stage: "none" };

        const ebookSummary = await loadEbookSummary(projectId);

        // compute availability
        const available = {
          origin: !!(originDoc?.text_content || content.origin?.content),
          translation:
            !!content.translation?.content ||
            batches.some((b) => !!b.translatedText),
          qualityAssessment: !!qualityAssessment,
          proofreading: !!proofreading.exists,
        };

        // translationStage detailed logic
        let translationStage = "no-origin";
        const hasOrigin = available.origin;
        const hasBatches = batches.length > 0;
        const anyBatchError = batches.some(
          (b) => b.status === "failed" || b.error,
        );
        const allBatchesDone =
          hasBatches && batches.every((b) => b.status === "done");
        const someDone = hasBatches && batches.some((b) => b.status === "done");
        const hasTranslationContent = !!(
          content.translation && content.translation.content
        );

        // If there's direct translation content in Mongo, prefer that when batches are absent
        if (!hasBatches && hasTranslationContent) {
          translationStage = content.translation.isPartial
            ? "translating"
            : "translated";
        } else {
          if (!hasOrigin && !hasBatches) translationStage = "no-origin";
          else if (hasOrigin && !hasBatches) translationStage = "origin-only";
          else if (anyBatchError) translationStage = "translation-error";
          else if (allBatchesDone) translationStage = "translated";
          else if (someDone) translationStage = "translating";
          else translationStage = "translating";
        }

        // quality assessment stage
        let qualityAssessmentStage = "no-assessment";
        if (qualityAssessment) qualityAssessmentStage = "done";

        // proofreading stage
        let proofreadingStage = "no-proofreading";
        if (proofreading.exists)
          proofreadingStage = proofreading.stage || "done";

        let documentProfiles = {
          origin: null as any,
          translation: null as any,
        };
        let originProfileDoc: any = null;
        let translationProfileDoc: any = null;
        try {
          const [originProfileDocResult, translationProfileDocResult] =
            await Promise.all([
              DocumentProfile.findOne({
                project_id: projectId,
                type: "origin",
              })
                .sort({ version: -1 })
                .lean()
                .exec(),
              DocumentProfile.findOne({
                project_id: projectId,
                type: "translation",
              })
                .sort({ version: -1 })
                .lean()
                .exec(),
            ]);
          originProfileDoc = originProfileDocResult;
          translationProfileDoc = translationProfileDocResult;
          documentProfiles = {
            origin: serializeDocumentProfile(originProfileDocResult),
            translation: serializeDocumentProfile(translationProfileDocResult),
          };

          const latestTranslationFileId =
            content.translation?.translationFileId ?? null;
          const translationProfileFileId =
            documentProfiles.translation?.references?.translationFileId ?? null;

          if (
            latestTranslationFileId &&
            latestTranslationFileId !== translationProfileFileId &&
            userId
          ) {
            let hasQueuedJob = false;
            try {
              const { rows } = await query(
                `SELECT document_id FROM jobs WHERE type = $1 AND status IN ('queued','running') AND project_id = $2 ORDER BY created_at DESC LIMIT 5`,
                ["profile", projectId],
              );
              hasQueuedJob = rows.some((row: any) => {
                const payloadRaw = row?.document_id;
                if (typeof payloadRaw !== "string") return false;
                try {
                  const parsed = JSON.parse(payloadRaw);
                  if (parsed?.variant !== "translation") return false;
                  return (
                    (parsed?.translationFileId ?? null) ===
                    latestTranslationFileId
                  );
                } catch (err) {
                  return payloadRaw.includes('"variant":"translation"');
                }
              });
            } catch (err) {
              request.log.warn(
                { err, projectId },
                "[PROFILE] Failed to inspect queued translation profile jobs",
              );
            }

            if (!hasQueuedJob) {
              enqueueTranslationProfileJob({
                projectId,
                userId,
                payload: {
                  variant: "translation",
                  translationFileId: latestTranslationFileId,
                  triggeredBy: "latest-content-refresh",
                },
              }).catch((err: unknown) => {
                request.log.warn(
                  { err, projectId },
                  "[PROFILE] Failed to enqueue translation profile refresh",
                );
              });
            }
          }
        } catch (err) {
          request.log.warn(
            { err, projectId },
            "[PROFILE] Failed to load document profiles",
          );
        }

        let originPrep = null;
        try {
          originPrep = await loadOriginPrepSnapshot({
            projectId,
            originDoc,
            originProfile: originProfileDoc,
          });
        } catch (err) {
          request.log.warn(
            { err, projectId },
            "[ORIGIN_PREP] Failed to load prep snapshot",
          );
        }

        return ok(reply, {
          projectId,
          projectProfile,
          latestJob,
          content: {
            origin: originDoc
              ? {
                  content: originDoc.text_content,
                  timestamp: originDoc.updated_at,
                }
              : content.origin,
            translation: content.translation,
            // metadata from Postgres
            batchesMetadata: batches,
            // actual per-batch documents from Mongo (if present)
            batchesActualData: mongoBatchDocs,
          },
          documentProfiles,
          qualityAssessment,
          proofreading,
          translationStage,
          qualityAssessmentStage,
          proofreadingStage,
          available,
          originPrep,
          ebook: ebookSummary,
        });
      } catch (err) {
        return handleError(
          request,
          reply,
          err,
          "Failed to load project content (beta)",
        );
      }
    },
  );
};

export default evaluationRoutes;
