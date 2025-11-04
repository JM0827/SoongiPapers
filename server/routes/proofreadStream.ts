import type { FastifyPluginAsync } from "fastify";
import { requireAuthAndPlanCheck } from "../middleware/auth";
import { NdjsonStreamWriter } from "../lib/ndjsonStream";
import {
  subscribeProofreadEvents,
  type ProofreadStageEvent,
  type ProofreadPageEvent,
  type ProofreadCompleteEvent,
  type ProofreadErrorEvent,
} from "../services/proofreadEvents";
import { findProofreadRunById } from "../db/pg";
import {
  getProofreadItemsSlice,
  getProofreadRunSummary,
} from "../services/proofreadSummary";
import {
  flushProofreadStreamMeta,
  getProofreadStreamMeta,
  recordProofreadConnectionClose,
  recordProofreadConnectionOpen,
  recordProofreadFallback,
  recordProofreadHeartbeat,
} from "../services/proofreadStreamMeta";

const proofreadStreamRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/api/projects/:projectId/proofread/summary",
    {
      preHandler: requireAuthAndPlanCheck,
      schema: {
        querystring: {
          type: "object",
          properties: {
            runId: { type: "string" },
            proofreadingId: { type: "string" },
          },
          anyOf: [{ required: ["runId"] }, { required: ["proofreadingId"] }],
        },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const { runId, proofreadingId } = request.query as {
        runId?: string;
        proofreadingId?: string;
      };

      if (!runId && !proofreadingId) {
        reply.status(400).send({
          error: "run_id_required",
          message:
            "runId 또는 proofreadingId 쿼리 파라미터가 필요합니다.",
        });
        return;
      }

      try {
        const summary = await getProofreadRunSummary({
          projectId,
          runId: runId ?? null,
          proofreadingId: proofreadingId ?? null,
        });

        if (!summary) {
          reply.status(404).send({
            error: "proofread_summary_not_found",
            message: "요청한 교정 작업 요약을 찾을 수 없습니다.",
          });
          return;
        }

        reply.send({ summary });
      } catch (error) {
        request.log.error(
          { err: error, projectId, runId: runId ?? null, proofreadingId },
          "[ProofSSE] summary lookup failed",
        );
        reply.status(500).send({
          error: "proofread_summary_failed",
          message: "교정 요약 정보를 불러오지 못했습니다.",
        });
      }
    },
  );

  fastify.get(
    "/api/projects/:projectId/proofread/:runId/items",
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

      const parsedLimit = Number.isFinite(limit) ? Number(limit) : undefined;

      try {
        const result = await getProofreadItemsSlice({
          projectId,
          runId,
          cursor: cursor ?? null,
          limit: parsedLimit ?? null,
        });

        if (!result) {
          reply.status(404).send({
            error: "proofread_items_not_found",
            message: "요청한 교정 페이지를 찾을 수 없습니다.",
          });
          return;
        }

        const { summary, slice } = result;
        reply.send({
          projectId,
          runId: summary.runId ?? runId,
          proofreadingId: summary.proofreading.id ?? null,
          cursor: cursor ?? null,
          nextCursor: slice.nextCursor,
          hasMore: slice.hasMore,
          total: slice.total,
          events: slice.events,
        });
      } catch (error) {
        request.log.error(
          { err: error, projectId, runId, cursor },
          "[ProofSSE] items lookup failed",
        );
        reply.status(500).send({
          error: "proofread_items_failed",
          message: "교정 페이지 정보를 불러오지 못했습니다.",
        });
      }
    },
  );

  fastify.get(
    "/api/projects/:projectId/proofread/stream",
    {
      preHandler: requireAuthAndPlanCheck,
      schema: {
        querystring: {
          type: "object",
          properties: {
            runId: { type: "string" },
            proofreadingId: { type: "string" },
          },
          anyOf: [{ required: ["runId"] }, { required: ["proofreadingId"] }],
        },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const { runId, proofreadingId } = request.query as {
        runId?: string;
        proofreadingId?: string;
      };

      const streamRunId = runId ?? proofreadingId ?? null;

      if (!streamRunId) {
        reply.status(400).send({
          error: "run_id_required",
          message: "runId query parameter is required for proofread stream",
        });
        return;
      }

      reply.hijack();
      reply.raw.setHeader(
        "Content-Type",
        "application/x-ndjson; charset=utf-8",
      );
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.setHeader("Transfer-Encoding", "chunked");

      let closed = false;
      const writer = new NdjsonStreamWriter(reply.raw, {
        logger: request.log,
      });

      const send = (payload: Record<string, unknown>) => {
        if (closed) return;
        writer.write(payload);
      };

      const HEARTBEAT_INTERVAL_MS = Math.max(
        3000,
        Number(process.env.PROOFREAD_HEARTBEAT_MS ?? 4000),
      );
      let heartbeatTimer: NodeJS.Timeout | null = null;

      const aliasUsed = !runId && Boolean(proofreadingId);

      let found = true;
      try {
        const runRecord = await findProofreadRunById({
          projectId,
          proofreadRunId: streamRunId,
        });
        found = Boolean(runRecord);
      } catch (err) {
        request.log.warn(
          { err, projectId, runId: streamRunId },
          "[ProofSSE] lookup failed",
        );
        found = false;
      }

      request.log.info(
        {
          projectId,
          runId: streamRunId,
          alias: aliasUsed ? "proofreadingId" : "runId",
          found,
        },
        "[ProofSSE] open",
      );

      recordProofreadConnectionOpen({
        projectId,
        runId: streamRunId,
      });

      if (!found) {
        recordProofreadFallback({
          projectId,
          runId: streamRunId,
          reason: "not_found",
        });
        send({
          type: "error",
          data: {
            project_id: projectId,
            proofread_id: streamRunId,
            proofreading_id: streamRunId,
            run_id: streamRunId,
            message: "Proofread run not found",
            retryable: false,
          },
        });

        try {
          const summary = await getProofreadRunSummary({
            projectId,
            runId: runId ?? null,
            proofreadingId: proofreadingId ?? null,
          });
          if (summary) {
            send({
              type: "summary",
              data: summary,
            });
          }
        } catch (error) {
          recordProofreadFallback({
            projectId,
            runId: streamRunId,
            reason: "summary_lookup_failed",
          });
          request.log.info(
            {
              err: error,
              projectId,
              runId: runId ?? null,
              proofreadingId: proofreadingId ?? null,
            },
            "[ProofSSE] summary fallback failed",
          );
        }

        send({
          type: "end",
          data: {
            project_id: projectId,
            run_id: streamRunId,
            proofreading_id: streamRunId,
            completed: false,
            reason: "not_found",
          },
        });

        closed = true;
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        writer.close();
        recordProofreadConnectionClose(streamRunId);
        void flushProofreadStreamMeta(streamRunId);
        return;
      }

      const startHeartbeat = () => {
        if (heartbeatTimer) return;
        heartbeatTimer = setInterval(() => {
          if (closed) return;
          const timestamp = new Date().toISOString();
          send({
            type: "heartbeat",
            project_id: projectId,
            run_id: streamRunId,
            proofreading_id: streamRunId,
            timestamp,
          });
          recordProofreadHeartbeat({
            projectId,
            runId: streamRunId,
          });
          request.log.trace(
            {
              projectId,
              runId: streamRunId,
              timestamp,
            },
            "[ProofSSE] heartbeat",
          );
        }, HEARTBEAT_INTERVAL_MS);
      };
      startHeartbeat();

      const unsubscribeStage = subscribeProofreadEvents(
        streamRunId,
        "stage",
        (event: ProofreadStageEvent) => {
          if (event.projectId !== projectId) return;
          send({
            type: "stage",
            data: {
              project_id: event.projectId,
              run_id: event.runId,
              proofreading_id: event.proofreadingId ?? null,
              tier: event.tier ?? null,
              key: event.key ?? null,
              stage: event.stage,
              status: event.status,
              label: event.label ?? null,
              message: event.message ?? null,
              item_count: event.itemCount ?? null,
            },
          });
        },
      );

      const unsubscribeTier = subscribeProofreadEvents(
        streamRunId,
        "tier",
        (event) => {
          if (event.projectId !== projectId) return;
          send({
            type: "tier_complete",
            data: {
              project_id: event.projectId,
              run_id: event.runId,
              proofreading_id: event.proofreadingId ?? null,
              tier: event.tier,
              summary: event.summary ?? null,
              item_count: event.itemCount ?? null,
              completedAt: event.completedAt,
            },
          });
        },
      );

      const unsubscribePage = subscribeProofreadEvents(
        streamRunId,
        "page",
        (event: ProofreadPageEvent) => {
          if (event.projectId !== projectId) return;
          send({
            type: "items",
            data: {
              project_id: event.projectId,
              run_id: event.runId,
              proofreading_id: event.proofreadingId ?? null,
              page: event.envelope,
              tier: event.tier ?? null,
              key: event.key ?? null,
              chunk_index: event.chunkIndex ?? null,
            },
          });
        },
      );

      const unsubscribeComplete = subscribeProofreadEvents(
        streamRunId,
        "complete",
        (event: ProofreadCompleteEvent) => {
          if (event.projectId !== projectId) return;
          send({
            type: "complete",
            data: {
              project_id: event.projectId,
              run_id: event.runId,
              proofreading_id: event.proofreadingId ?? null,
              scope: event.scope ?? "run",
              completedAt: event.completedAt,
              summary: event.summary ?? null,
            },
          });
          send({
            type: "end",
            data: {
              project_id: event.projectId,
              run_id: event.runId,
              proofreading_id: event.proofreadingId ?? null,
              completed: true,
              reason: "complete",
            },
          });
          closed = true;
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
          writer.close();
        },
      );

      const unsubscribeError = subscribeProofreadEvents(
        streamRunId,
        "error",
        (event: ProofreadErrorEvent) => {
          if (event.projectId !== projectId) return;
          send({
            type: "error",
            data: {
              project_id: event.projectId,
              run_id: event.runId,
              proofreading_id: event.proofreadingId ?? null,
              stage: event.stage ?? null,
              message: event.message,
              retryable: event.retryable ?? false,
              reason: event.reason ?? null,
            },
          });
          send({
            type: "end",
            data: {
              project_id: event.projectId,
              run_id: event.runId,
              proofreading_id: event.proofreadingId ?? null,
              completed: false,
              reason: event.stage ? `${event.stage}_error` : "error",
            },
          });
          closed = true;
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
          writer.close();
        },
      );

      request.raw.once("close", () => {
        closed = true;
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        unsubscribeStage();
        unsubscribeTier();
        unsubscribePage();
        unsubscribeComplete();
        unsubscribeError();
        writer.close();
        recordProofreadConnectionClose(streamRunId);
        const metricsSnapshot = getProofreadStreamMeta(streamRunId);
        if (metricsSnapshot) {
          request.log.info(
            {
              projectId,
              runId: streamRunId,
              metrics: metricsSnapshot,
            },
            "[ProofSSE] stream metrics snapshot",
          );
        }
        void flushProofreadStreamMeta(streamRunId);
        request.log.info(
          {
            projectId,
            runId: streamRunId,
            alias: aliasUsed ? "proofreadingId" : "runId",
            found,
          },
          "[ProofSSE] close",
        );
      });
    },
  );
};

export default proofreadStreamRoutes;
