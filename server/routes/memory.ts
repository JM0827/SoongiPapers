import type { FastifyInstance } from "fastify";

import {
  fetchProjectMemory,
  ensureProjectMemory,
  mergeProjectMemory,
  getCurrentMemoryRecord,
} from "../services/translation/memory";
import { requireAuthAndPlanCheck } from "../middleware/auth";

export default async function memoryRoutes(app: FastifyInstance) {
  app.get("/api/memory/current", async (request, reply) => {
    await requireAuthAndPlanCheck(request, reply);
    if ((reply as any).sent) return;

    const { projectId, version } = request.query as {
      projectId?: string;
      version?: string;
    };

    if (!projectId) {
      reply.status(400).send({ error: "projectId is required" });
      return;
    }

    try {
      if (version && Number(version) > 0) {
        const memory = await fetchProjectMemory(projectId, Number(version));
        reply.send({ projectId, version: Number(version), memory });
        return;
      }

      const current = await getCurrentMemoryRecord(projectId);
      reply.send({
        projectId,
        version: current?.version ?? null,
        memory: current?.memory ?? null,
      });
    } catch (error) {
      request.log.error(
        { err: error, projectId },
        "[MEMORY] Failed to fetch memory",
      );
      reply.status(500).send({ error: "Failed to fetch project memory" });
    }
  });

  app.post("/api/memory/init", async (request, reply) => {
    await requireAuthAndPlanCheck(request, reply);
    if ((reply as any).sent) return;

    const body = request.body as {
      projectId?: string;
      memory?: unknown;
    };

    if (!body?.projectId || typeof body.projectId !== "string") {
      reply.status(400).send({ error: "projectId is required" });
      return;
    }

    try {
      const record = await ensureProjectMemory(
        body.projectId,
        body.memory as Record<string, unknown> | undefined as any,
      );
      reply.status(201).send(record);
    } catch (error) {
      request.log.error(
        { err: error, projectId: body.projectId },
        "[MEMORY] Failed to init memory",
      );
      reply.status(500).send({ error: "Failed to initialize project memory" });
    }
  });

  app.post("/api/memory/update", async (request, reply) => {
    await requireAuthAndPlanCheck(request, reply);
    if ((reply as any).sent) return;

    const body = request.body as {
      projectId?: string;
      memory?: unknown;
    };

    if (!body?.projectId || typeof body.projectId !== "string") {
      reply.status(400).send({ error: "projectId is required" });
      return;
    }

    try {
      const record = await mergeProjectMemory(
        body.projectId,
        body.memory as Record<string, unknown> | undefined as any,
      );
      reply.send(record);
    } catch (error) {
      request.log.error(
        { err: error, projectId: body.projectId },
        "[MEMORY] Failed to update memory",
      );
      reply.status(500).send({ error: "Failed to update project memory" });
    }
  });
}
