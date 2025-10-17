import type { FastifyPluginAsync } from 'fastify';
import { requireAuthAndPlanCheck } from '../middleware/auth';
import {
  buildProofreadEditorDataset,
  saveProofreadEditorSegments,
  type BuildProofreadEditorDatasetParams,
  type ProofreadEditorPatchPayload,
} from '../services/proofreadEditor';
import { subscribeProofreadEditorUpdates } from '../services/proofreadEditorEvents';

const proofreadEditorRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/api/projects/:projectId/proofread/editor',
    {
      preHandler: requireAuthAndPlanCheck,
    },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const { jobId = null, translationFileId = null } = request.query as {
        jobId?: string | null;
        translationFileId?: string | null;
      };

      try {
        const params: BuildProofreadEditorDatasetParams = {
          projectId,
          jobId,
          translationFileId,
        };
        const payload = await buildProofreadEditorDataset(params);
        return reply.send(payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        if (message.includes('not found')) {
          return reply.status(404).send({
            code: 'NOT_FOUND',
            message,
          });
        }
        if (message === 'Invalid translationFileId') {
          return reply.status(400).send({
            code: 'VALIDATION_ERROR',
            message,
          });
        }
        fastify.log.error({ err: error }, 'Failed to load proofread editor dataset');
        return reply.status(500).send({
          code: 'INTERNAL_ERROR',
          message: 'Failed to load proofread editor dataset',
        });
      }
    },
  );

  fastify.patch(
    '/api/projects/:projectId/proofread/editor/segments',
    {
      preHandler: requireAuthAndPlanCheck,
    },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const {
        translationFileId,
        documentVersion,
        segments,
        jobId = null,
        clientMutationId = null,
      } = request.body as {
        translationFileId?: string;
        documentVersion?: string;
        jobId?: string | null;
        segments?: Array<{
          segmentId: string;
          column: 'origin' | 'translation';
          text: string;
        }>;
        clientMutationId?: string | null;
      };

      if (!translationFileId) {
        return reply.status(400).send({
          code: 'VALIDATION_ERROR',
          message: 'translationFileId is required',
        });
      }

      if (!documentVersion) {
        return reply.status(400).send({
          code: 'VALIDATION_ERROR',
          message: 'documentVersion is required',
        });
      }

      if (!Array.isArray(segments) || segments.length === 0) {
        return reply.status(400).send({
          code: 'VALIDATION_ERROR',
          message: 'segments payload is required',
        });
      }

      try {
        const payload: ProofreadEditorPatchPayload = {
          projectId,
          translationFileId,
          documentVersion,
          segments,
          jobId,
          clientMutationId,
        };
        const result = await saveProofreadEditorSegments(payload);
        return reply.send(result);
      } catch (error) {
        const status = (error as Error & { status?: number }).status;
        const details = (error as Error & { details?: unknown }).details;
        const message = error instanceof Error ? error.message : 'Unknown error';

        if (status === 409) {
          return reply.status(409).send({
            code: 'CONFLICT',
            message,
            details,
          });
        }

        if (message === 'Invalid translationFileId') {
          return reply.status(400).send({
            code: 'VALIDATION_ERROR',
            message,
          });
        }

        if (message.includes('not found')) {
          return reply.status(404).send({
            code: 'NOT_FOUND',
            message,
          });
        }

        fastify.log.error({ err: error }, 'Failed to save proofread editor segments');
        return reply.status(500).send({
          code: 'INTERNAL_ERROR',
          message: 'Failed to save proofread editor segments',
        });
      }
    },
  );

  fastify.get(
    '/api/projects/:projectId/proofread/editor/stream',
    {
      preHandler: requireAuthAndPlanCheck,
    },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const { jobId = null, translationFileId = null } = request.query as {
        jobId?: string | null;
        translationFileId?: string | null;
      };

      reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
      reply.raw.setHeader('Connection', 'keep-alive');
      if (typeof (reply.raw as any).flushHeaders === 'function') {
        (reply.raw as any).flushHeaders();
      }

      const sendEvent = (event: Record<string, unknown>) => {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        if (typeof (reply.raw as any).flush === 'function') {
          (reply.raw as any).flush();
        }
      };

      const unsubscribe = subscribeProofreadEditorUpdates(projectId, (event) => {
        if (translationFileId && event.translationFileId !== translationFileId) {
          return;
        }
        if (jobId && event.jobId !== jobId) {
          return;
        }
        sendEvent({ type: 'proofread.update', ...event });
      });

      const heartbeatInterval = setInterval(() => {
        reply.raw.write(': heartbeat\n\n');
        if (typeof (reply.raw as any).flush === 'function') {
          (reply.raw as any).flush();
        }
      }, 30_000);
      heartbeatInterval.unref?.();

      request.raw.on('close', () => {
        clearInterval(heartbeatInterval);
        unsubscribe();
      });

      request.raw.on('error', () => {
        clearInterval(heartbeatInterval);
        unsubscribe();
      });

      sendEvent({ type: 'proofread.ready', projectId, jobId, translationFileId });
      return reply; // keep connection open
    },
  );
};

export default proofreadEditorRoutes;
