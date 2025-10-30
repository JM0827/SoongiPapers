import type { FastifyInstance } from "fastify";
import { requireAuthAndPlanCheck } from "../middleware/auth";
import { listProofreadingLogs } from "../db/proofreadingLog";
import { listRecentDraftRuns } from "../services/translationDrafts";

type QueryParams = {
  projectId?: string;
  limit?: string;
};

export default async function adminRoutes(fastify: FastifyInstance) {
  fastify.get<{
    Querystring: QueryParams;
  }>(
    "/api/admin/proofreading/logs",
    {
      preHandler: requireAuthAndPlanCheck,
    },
    async (request) => {
      const { projectId, limit } = request.query;
      const parsedLimit = limit ? Number(limit) : undefined;
      const safeLimit = Number.isFinite(parsedLimit) && parsedLimit! > 0
        ? Math.min(parsedLimit!, 500)
        : undefined;

      const logs = await listProofreadingLogs({
        projectId: projectId?.trim() || undefined,
        limit: safeLimit,
      });

      return { logs };
    },
  );

  fastify.get<{
    Querystring: QueryParams;
  }>(
    "/api/admin/translation/drafts",
    {
      preHandler: requireAuthAndPlanCheck,
    },
    async (request) => {
      const { projectId, limit } = request.query;
      const parsedLimit = limit ? Number(limit) : undefined;
      const safeLimit = Number.isFinite(parsedLimit) && parsedLimit! > 0
        ? Math.min(parsedLimit!, 200)
        : undefined;

      const drafts = await listRecentDraftRuns({
        projectId: projectId?.trim() || undefined,
        limit: safeLimit,
      });

      return { drafts };
    },
  );
}
