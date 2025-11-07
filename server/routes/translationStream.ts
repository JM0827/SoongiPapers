import type { FastifyPluginAsync } from "fastify";
import { requireAuthAndPlanCheck } from "../middleware/auth";
import { NdjsonStreamWriter } from "../lib/ndjsonStream";
import { query } from "../db";
import { getStreamRunMetrics } from "../db/streamRunMetrics";
import {
  subscribeTranslationEvents,
  type TranslationStageEvent,
  type TranslationPageEvent,
  type TranslationCompleteEvent,
  type TranslationErrorEvent,
  translationRunId,
} from "../services/translationEvents";
import {
  fetchTranslationStreamMeta,
  flushTranslationStreamMeta,
  recordTranslationConnectionClose,
  recordTranslationConnectionOpen,
  recordTranslationEvent,
  recordTranslationFallback,
  recordTranslationHeartbeat,
  recordTranslationMetricsSnapshot,
} from "../services/translationStreamMeta";
import { getTranslationItemsSlice } from "../services/translation/translationItemsSlice";
import { getTranslationRunSummary } from "../services/translationSummary";
import { enqueueCanonicalWarmupJob } from "../services/translation/canonicalWarmupQueue";
import { getCanonicalCacheState } from "../services/translation/canonicalCache";
import { updateCanonicalCacheState } from "../services/translationSummaryState";

const HEARTBEAT_INTERVAL_MS = Math.max(
  10_000,
  Number(process.env.TRANSLATION_HEARTBEAT_MS ?? 12_000),
);

const translationStreamRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/api/projects/:projectId/translations/summary",
    {
      preHandler: requireAuthAndPlanCheck,
      schema: {
        querystring: {
          type: "object",
          properties: {
            runId: { type: "string" },
            jobId: { type: "string" },
          },
          anyOf: [{ required: ["runId"] }, { required: ["jobId"] }],
        },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const { runId, jobId } = request.query as {
        runId?: string;
        jobId?: string;
      };

      if (!runId && !jobId) {
        reply.status(400).send({
          error: "run_id_required",
          message: "runId 또는 jobId 파라미터가 필요합니다.",
        });
        return;
      }

      try {
        const summary = await getTranslationRunSummary({
          projectId,
          runId: runId ?? null,
          jobId: jobId ?? null,
        });

        if (!summary) {
          reply.status(404).send({
            error: "translation_summary_not_found",
            message: "요청한 번역 요약 정보를 찾을 수 없습니다.",
          });
          return;
        }

        reply.send({ summary });
      } catch (error) {
        request.log.error(
          { err: error, projectId, runId: runId ?? null, jobId: jobId ?? null },
          "[TranslationSSE] summary lookup failed",
        );
        reply.status(500).send({
          error: "translation_summary_failed",
          message: "번역 요약 정보를 불러오지 못했습니다.",
        });
      }
    },
  );

  fastify.post(
    "/api/projects/:projectId/translations/:jobId/canonical/warmup",
    {
      preHandler: requireAuthAndPlanCheck,
    },
    async (request, reply) => {
      const { projectId, jobId } = request.params as {
        projectId: string;
        jobId: string;
      };

      const normalizedProjectId = projectId?.trim();
      const normalizedJobId = jobId?.trim();
      if (!normalizedProjectId || !normalizedJobId) {
        reply.status(400).send({ error: "invalid_params" });
        return;
      }

      const runId = translationRunId(normalizedJobId);

      try {
        const { rows } = await query(
          `SELECT id,
                  project_id,
                  origin_file,
                  origin_lang,
                  target_lang
             FROM jobs
            WHERE id = $1 AND project_id = $2 AND type = 'translate'
            LIMIT 1`,
          [normalizedJobId, normalizedProjectId],
        );

        if (!rows.length) {
          reply.status(404).send({ error: "translation_job_not_found" });
          return;
        }

        const streamRow = await getStreamRunMetrics(runId);
        const cacheSnapshot = await getCanonicalCacheState({
          runId,
          extras: streamRow?.extras ?? null,
        });

        if (cacheSnapshot.state === "ready") {
          reply.send({ state: "ready", runId });
          return;
        }

        if (cacheSnapshot.state === "warming") {
          reply.send({ state: "warming", runId });
          return;
        }

        await updateCanonicalCacheState({
          projectId: normalizedProjectId,
          runId,
          state: "warming",
        });

        await enqueueCanonicalWarmupJob({
          projectId: normalizedProjectId,
          jobId: normalizedJobId,
          runId,
          originDocumentId: rows[0].origin_file ?? null,
          originLanguage: rows[0].origin_lang ?? null,
          targetLanguage: rows[0].target_lang ?? null,
        });

        reply.code(202).send({ state: "warming", runId });
      } catch (error) {
        request.log.error(
          { err: error, projectId: normalizedProjectId, jobId: normalizedJobId },
          "[TranslationCanonical] warmup enqueue failed",
        );
        reply.status(500).send({
          error: "canonical_warmup_failed",
          message: "canonical 세그먼트를 준비하지 못했습니다.",
        });
      }
    },
  );

  fastify.get(
    "/api/projects/:projectId/translations/:runId/items",
    {
      preHandler: requireAuthAndPlanCheck,
      schema: {
        querystring: {
          type: "object",
          properties: {
            cursor: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 10 },
          },
        },
      },
    },
    async (request, reply) => {
      const { projectId, runId } = request.params as {
        projectId: string;
        runId: string;
      };
      const { cursor, limit } = request.query as {
        cursor?: string;
        limit?: number;
      };

      try {
        const result = await getTranslationItemsSlice({
          projectId,
          runId,
          cursor: cursor ?? null,
          limit: limit ?? null,
        });

        if (!result) {
          reply.status(404).send({
            error: "translation_items_not_found",
            message: "요청한 번역 페이지를 찾을 수 없습니다.",
          });
          return;
        }

        const { summary, slice } = result;
        reply.send({
          projectId,
          runId: summary.runId ?? runId,
          jobId: summary.jobId ?? null,
          cursor: cursor ?? null,
          nextCursor: slice.nextCursor,
          hasMore: slice.hasMore,
          total: slice.total,
          events: slice.events,
          canonicalCacheState: summary.canonicalCacheState,
        });
        request.log.info(
          {
            projectId,
            runId: summary.runId ?? runId,
            cursor: cursor ?? null,
            eventCount: slice.events.length,
            nextCursor: slice.nextCursor,
            hasMore: slice.hasMore,
          },
          "[TranslationREST] items slice served",
        );
      } catch (error) {
        request.log.error(
          { err: error, projectId, runId, cursor },
          "[TranslationSSE] items lookup failed",
        );
        reply.status(500).send({
          error: "translation_items_failed",
          message: "번역 페이지 정보를 불러오지 못했습니다.",
        });
      }
    },
  );

  fastify.get(
    "/api/projects/:projectId/translations/stream",
    {
      preHandler: requireAuthAndPlanCheck,
      schema: {
        querystring: {
          type: "object",
          required: ["jobId"],
          properties: {
            jobId: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const { jobId } = request.query as { jobId: string };

      if (!jobId) {
        reply.status(400).send({
          error: "jobId_required",
          message: "jobId query parameter is required for translation stream",
        });
        return;
      }

      reply.hijack();
      reply.raw.setHeader(
        "Content-Type",
        "application/x-ndjson; charset=utf-8",
      );
      reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.setHeader("Transfer-Encoding", "chunked");
      reply.raw.setHeader("Content-Encoding", "identity");
      reply.raw.setHeader("X-Accel-Buffering", "no");

      if (typeof reply.raw.flushHeaders === "function") {
        reply.raw.flushHeaders();
      }

      let closed = false;
      const writer = new NdjsonStreamWriter(reply.raw, {
        logger: request.log,
      });

      const send = (payload: Record<string, unknown>) => {
        if (closed) return;
        writer.write(payload);
      };

      const runId = translationRunId(jobId);
      let finished = false;
      let heartbeatTimer: NodeJS.Timeout | null = null;
      let reconnectAttempt = 0;
      const MAX_RECONNECT_ATTEMPTS = 10;

      const sendEnd = (completed: boolean, reason: string) => {
        if (finished || closed) return;
        finished = true;
        send({
          type: "end",
          data: {
            run_id: runId,
            completed,
            reason,
          },
        });
        closed = true;
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        writer.close();
      };

      recordTranslationConnectionOpen({
        runId,
        projectId,
      });
      void recordTranslationMetricsSnapshot(
        {
          runId,
          projectId,
          extras: {
            retry: {
              limitReached: false,
              reconnectAttempts: reconnectAttempt,
              updatedAt: new Date().toISOString(),
            },
          } as Record<string, unknown>,
        },
        { mergeExtras: true },
      );

      const startHeartbeat = () => {
        if (heartbeatTimer) return;
        heartbeatTimer = setInterval(() => {
          if (closed) return;
          const timestamp = new Date().toISOString();
          send({
            type: "heartbeat",
            project_id: projectId,
            run_id: runId,
            timestamp,
          });
          recordTranslationHeartbeat({ runId, projectId });
        }, HEARTBEAT_INTERVAL_MS);
      };
      startHeartbeat();

      writer.write({});
      send({ type: "heartbeat", data: {} });

      try {
        const summary = await getTranslationRunSummary({ projectId, runId });
        if (summary) {
          send({ type: "summary", data: summary });
        } else {
          const persisted = await fetchTranslationStreamMeta(runId);
          if (!persisted) {
            recordTranslationFallback({
              runId,
              projectId,
              reason: "summary_missing",
            });
          }
        }
      } catch (error) {
        request.log.info(
          { err: error, projectId, runId },
          "[TranslationSSE] summary preload failed",
        );
        recordTranslationFallback({
          runId,
          projectId,
          reason: "summary_error",
        });
      }

      const unsubscribeStage = subscribeTranslationEvents(
        jobId,
        "stage",
        (event: TranslationStageEvent) => {
          if (event.projectId !== projectId) return;
          send({
            type: "stage",
            data: {
              run_id: event.runId,
              job_id: event.jobId,
              chunk_id: event.chunkId ?? null,
              stage: event.stage,
              status: event.status,
              label: event.label ?? null,
              message: event.message ?? null,
              item_count: event.itemCount ?? null,
            },
          });
          recordTranslationEvent({
            runId,
            projectId,
            type: `stage:${event.stage}`,
          });
        },
      );

      const unsubscribePage = subscribeTranslationEvents(
        jobId,
        "page",
        (event: TranslationPageEvent) => {
          if (event.projectId !== projectId) return;
          send({
            type: "items",
            data: event.envelope,
          });
          request.log.info(
            {
              projectId,
              runId,
              jobId,
              stage: event.stage,
              chunkId: event.envelope.chunk_id,
              hasMore: event.envelope.has_more,
              nextCursor: event.envelope.next_cursor,
            },
            "[TranslationSSE] items dispatched",
          );
          const emitted = event.envelope.stats?.item_count ??
            event.envelope.items.length;
          send({
            type: "progress",
            data: {
              run_id: event.envelope.run_id,
              chunk_id: event.envelope.chunk_id,
              emitted,
              total: null,
              has_more: event.envelope.has_more,
            },
          });
          recordTranslationEvent({
            runId,
            projectId,
            type: `items:${event.stage}`,
          });
        },
      );

      const unsubscribeComplete = subscribeTranslationEvents(
        jobId,
        "complete",
        (event: TranslationCompleteEvent) => {
          if (event.projectId !== projectId) return;
          send({
            type: "complete",
            data: {
              run_id: event.runId,
              job_id: event.jobId,
              translation_file_id: event.translationFileId,
              completedAt: event.completedAt,
            },
          });
          sendEnd(true, "complete");
          recordTranslationEvent({
            runId,
            projectId,
            type: "complete",
          });
        },
      );

      const unsubscribeError = subscribeTranslationEvents(
        jobId,
        "error",
        (event: TranslationErrorEvent) => {
          if (event.projectId !== projectId) return;
          send({
            type: "error",
            data: {
              run_id: event.runId,
              job_id: event.jobId,
              stage: event.stage ?? null,
              message: event.message,
              retryable: event.retryable ?? false,
            },
          });
          sendEnd(false, event.stage ? `${event.stage}_error` : "error");
          recordTranslationFallback({
            runId,
            projectId,
            reason: event.stage ? `${event.stage}_error` : "error",
          });
          reconnectAttempt = MAX_RECONNECT_ATTEMPTS + 1;
        },
      );

      request.raw.once("close", () => {
        let exceedLimit = false;
        if (!finished) {
          reconnectAttempt += 1;
          if (reconnectAttempt > MAX_RECONNECT_ATTEMPTS) {
            exceedLimit = true;
            request.log.warn(
              {
                projectId,
                runId,
                reconnectAttempt,
              },
              "[TranslationSSE] reconnect attempts exceeded",
            );
            void recordTranslationMetricsSnapshot(
              {
                runId,
                projectId,
                extras: {
                  retry: {
                    limitReached: true,
                    reconnectAttempts: reconnectAttempt,
                    updatedAt: new Date().toISOString(),
                  },
                } as Record<string, unknown>,
              },
              { mergeExtras: true },
            );
          }
        }

        closed = true;
        unsubscribeStage();
        unsubscribePage();
        unsubscribeComplete();
        unsubscribeError();
        if (!finished) {
          finished = true;
        }
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        writer.close();
        recordTranslationConnectionClose(runId);
        if (!exceedLimit) {
          void recordTranslationMetricsSnapshot(
            {
              runId,
              projectId,
              extras: {
                retry: {
                  limitReached: false,
                  reconnectAttempts: reconnectAttempt,
                  updatedAt: new Date().toISOString(),
                },
              } as Record<string, unknown>,
            },
            { mergeExtras: true },
          );
        }
        void flushTranslationStreamMeta(runId);
      });
    },
  );
};

export default translationStreamRoutes;
