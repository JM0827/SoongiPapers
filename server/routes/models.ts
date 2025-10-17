import type { FastifyPluginAsync } from "fastify";
import { requireAuthAndPlanCheck } from "../middleware/auth";
import { listChatModels, DEFAULT_CHAT_MODEL } from "../services/modelService";

const modelsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/api/models",
    {
      preHandler: requireAuthAndPlanCheck,
    },
    async (_request, reply) => {
      const models = listChatModels();
      reply.send({
        models,
        defaultModel: DEFAULT_CHAT_MODEL,
      });
    },
  );
};

export default modelsRoutes;
