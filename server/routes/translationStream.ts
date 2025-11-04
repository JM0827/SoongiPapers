import type { FastifyPluginAsync } from "fastify";
import { requireAuthAndPlanCheck } from "../middleware/auth";
import { NdjsonStreamWriter } from "../lib/ndjsonStream";
import {
  subscribeTranslationEvents,
  type TranslationStageEvent,
  type TranslationPageEvent,
  type TranslationCompleteEvent,
  type TranslationErrorEvent,
  translationRunId,
} from "../services/translationEvents";

const translationStreamRoutes: FastifyPluginAsync = async (fastify) => {
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

      const runId = translationRunId(jobId);
      let finished = false;

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
        writer.close();
      };

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
        },
      );

      request.raw.once("close", () => {
        closed = true;
        unsubscribeStage();
        unsubscribePage();
        unsubscribeComplete();
        unsubscribeError();
        if (!finished) {
          finished = true;
        }
        writer.close();
      });
    },
  );
};

export default translationStreamRoutes;
