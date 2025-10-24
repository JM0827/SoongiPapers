// Fastify 라우트 플러그인
import { FastifyPluginAsync } from "fastify";
import { runProofreading } from "../agents/proofreading/ProofReadingAgent";
import { requireAuthAndPlanCheck } from "../middleware/auth";
import { applyProofreadingChanges } from "../db/mongo";
import {
  completeAction as completeWorkflowRun,
  failAction as failWorkflowRun,
  requestAction as requestWorkflowAction,
  WorkflowRunRecord,
} from "../services/workflowManager";

const proofreadingRoutes: FastifyPluginAsync = async (fastify) => {
  // (선택) JWT를 쓰면 여기에서 req.jwtVerify() 훅 추가 가능
  // fastify.addHook("onRequest", async (req) => { await req.jwtVerify(); });

  fastify.post(
    "/api/proofread",
    {
      schema: {
        body: {
          type: "object",
          required: ["project_id", "job_id"],
          properties: {
            project_id: { type: "string" },
            job_id: { type: "string" },
            workflowLabel: { type: "string" },
            workflowAllowParallel: { type: "boolean" },
            includeDeep: { type: "boolean" },
          },
        },
      },
      preHandler: requireAuthAndPlanCheck,
    },
    async (req, reply) => {
      reply.hijack();

      reply.raw.setHeader(
        "Content-Type",
        "application/x-ndjson; charset=utf-8",
      );
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.setHeader("Transfer-Encoding", "chunked");

      const send = (payload: any) => {
        reply.raw.write(`${JSON.stringify(payload)}\n`);
        const raw: any = reply.raw as any;
        if (typeof raw.flush === "function") {
          raw.flush();
        }
      };

      let workflowRun: WorkflowRunRecord | null = null;
      try {
        const { project_id, job_id, workflowAllowParallel, includeDeep } =
          req.body as {
            project_id: string;
            job_id: string;
            workflowLabel?: string | null;
            workflowAllowParallel?: boolean;
            includeDeep?: boolean;
          };

        try {
          const result = await requestWorkflowAction({
            projectId: project_id,
            type: "proofread",
            requestedBy: (req as any).user_id ?? null,
            label: (req.body as any)?.workflowLabel ?? null,
            metadata: { jobId: job_id, source: "proofread.route" },
            allowParallel: Boolean(workflowAllowParallel),
          });
          if (!result.accepted || !result.run) {
            const reason = result.reason ?? "unknown";
            const conflictStatus = result.conflictStatus ?? null;
            const projectStatus = result.projectStatus ?? null;
            const message = (() => {
              if (reason === "already_running") {
                const statusText = conflictStatus ? ` (상태: ${conflictStatus})` : "";
                return `이미 진행 중인 교정 작업이 있어 새 작업을 시작할 수 없습니다.${statusText}`;
              }
              if (reason === "project_inactive") {
                const statusText = projectStatus ? ` (프로젝트 상태: ${projectStatus})` : "";
                return `프로젝트 상태 때문에 교정 작업을 시작할 수 없습니다.${statusText}`;
              }
              return "교정 작업을 시작할 수 없습니다.";
            })();

            send({
              type: "error",
              reason,
              conflictStatus,
              projectStatus,
              message,
            });
            reply.raw.end();
            return;
          }
          workflowRun = result.run;
          send({
            type: "workflow",
            status: "accepted",
            runId: workflowRun.runId,
            label: workflowRun.label,
          });
        } catch (workflowError: any) {
          send({
            type: "error",
            message:
              workflowError?.message ??
              "교정 워크플로우를 준비하지 못했습니다.",
          });
          reply.raw.end();
          return;
        }

        try {
          await runProofreading(project_id, job_id, send, {
            includeDeep: Boolean(includeDeep),
          });
          if (workflowRun) {
            await completeWorkflowRun(workflowRun.runId, { jobId: job_id });
          }
        } catch (error: any) {
          if (workflowRun) {
            await failWorkflowRun(workflowRun.runId, {
              jobId: job_id,
              error: error?.message ?? "unknown",
            });
          }
          send({
            type: "error",
            message: error?.message || "Proofreading failed",
          });
        }
      } catch (error: any) {
        send({
          type: "error",
          message: error?.message || "Proofreading failed",
        });
      } finally {
        reply.raw.end();
      }
    },
  );

  fastify.patch(
    "/api/proofread/:proofreadingId/apply",
    {
      schema: {
        params: {
          type: "object",
          required: ["proofreadingId"],
          properties: {
            proofreadingId: { type: "string" },
          },
        },
        body: {
          type: "object",
          required: ["appliedIssueIds", "translatedContent"],
          properties: {
            appliedIssueIds: { type: "array", items: { type: "string" } },
            translatedContent: { type: "string" },
          },
        },
      },
      preHandler: requireAuthAndPlanCheck,
    },
    async (req, reply) => {
      const { proofreadingId } = req.params as { proofreadingId: string };
      const { appliedIssueIds, translatedContent } = req.body as {
        appliedIssueIds: string[];
        translatedContent: string;
      };

      if (!Array.isArray(appliedIssueIds) || !translatedContent) {
        return reply.status(400).send({ error: "Invalid payload" });
      }

      try {
        const result = await applyProofreadingChanges({
          proofreading_id: proofreadingId,
          appliedIssueIds,
          translatedContent,
        });

        reply.send({
          proofreading_id: proofreadingId,
          report: result.report,
          quick_report: result.quick_report,
          deep_report: result.deep_report,
          applied_translated_content: result.applied_translated_content,
          updated_at: result.updated_at,
        });
      } catch (error: any) {
        reply.status(500).send({
          error: error?.message || "Failed to apply proofreading changes",
        });
      }
    },
  );
};

export default proofreadingRoutes;
