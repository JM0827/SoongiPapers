import { FastifyPluginAsync } from "fastify";
import { requireAuthAndPlanCheck } from "../middleware/auth";
import {
  cancelAction,
  completeAction,
  failAction,
  getWorkflowSummary,
  markProjectRunsCancelled,
  requestAction,
  WorkflowRunStatus,
  WorkflowType,
} from "../services/workflowManager";

const workflowRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/projects/:projectId/workflow",
    { preHandler: requireAuthAndPlanCheck },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      try {
        const summary = await getWorkflowSummary(projectId);
        reply.send(summary);
      } catch (error) {
        request.log.error({ err: error }, "[WORKFLOW] Failed to load summary");
        reply
          .status(500)
          .send({ error: "워크플로우 정보를 불러오지 못했습니다." });
      }
    },
  );

  fastify.post(
    "/projects/:projectId/workflow/actions",
    { preHandler: requireAuthAndPlanCheck },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const body = request.body as {
        type: WorkflowType;
        label?: string | null;
        intentText?: string | null;
        metadata?: Record<string, unknown> | null;
        parentRunId?: string | null;
      };
      const userId = (request as any).user_id ?? null;

      try {
        const result = await requestAction({
          projectId,
          type: body.type,
          requestedBy: userId,
          intentText: body.intentText ?? null,
          label: body.label ?? null,
          metadata: body.metadata ?? null,
          parentRunId: body.parentRunId ?? null,
        });
        if (!result.accepted) {
          return reply.status(409).send({
            accepted: false,
            reason: result.reason,
            projectStatus: result.projectStatus,
            conflictRun: result.conflictRun ?? null,
            conflictStatus: result.conflictStatus ?? null,
          });
        }
        reply.send({ accepted: true, run: result.run });
      } catch (error) {
        request.log.error(
          { err: error },
          "[WORKFLOW] Failed to request action",
        );
        reply.status(500).send({
          error: "새 작업을 시작하지 못했습니다. 다시 시도해 주세요.",
        });
      }
    },
  );

  fastify.post(
    "/projects/:projectId/workflow/:runId/status",
    { preHandler: requireAuthAndPlanCheck },
    async (request, reply) => {
      const { projectId, runId } = request.params as {
        projectId: string;
        runId: string;
      };
      const body = request.body as {
        status: WorkflowRunStatus;
        metadata?: Record<string, unknown> | null;
      };

      try {
        let updated;
        switch (body.status) {
          case "succeeded":
            updated = await completeAction(runId, body.metadata ?? undefined);
            break;
          case "failed":
            updated = await failAction(runId, body.metadata ?? undefined);
            break;
          case "cancelled":
            updated = await cancelAction(runId, body.metadata ?? undefined);
            break;
          default:
            return reply.status(400).send({ error: "Unsupported status" });
        }
        reply.send({ run: updated });
      } catch (error) {
        request.log.error({ err: error }, "[WORKFLOW] Failed to update status");
        reply
          .status(500)
          .send({ error: "작업 상태를 업데이트하지 못했습니다." });
      }
    },
  );

  fastify.post(
    "/projects/:projectId/workflow/cancel-all",
    { preHandler: requireAuthAndPlanCheck },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const body = request.body as { reason?: string };
      try {
        await markProjectRunsCancelled(
          projectId,
          body?.reason ?? "project_inactive",
        );
        reply.send({ ok: true });
      } catch (error) {
        request.log.error({ err: error }, "[WORKFLOW] Failed to cancel runs");
        reply
          .status(500)
          .send({ error: "실행 중인 작업을 취소하지 못했습니다." });
      }
    },
  );
};

export default workflowRoutes;
