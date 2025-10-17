import { FastifyPluginAsync } from "fastify";
import fetch from "node-fetch";
import { requireAuthAndPlanCheck } from "../middleware/auth";

interface DictionaryQuery {
  word?: string;
}

const dictionaryRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/api/dictionary",
    {
      preHandler: requireAuthAndPlanCheck,
      schema: {
        querystring: {
          type: "object",
          required: ["word"],
          properties: {
            word: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { word } = request.query as DictionaryQuery;
      const normalized = (word ?? "").trim();
      if (!normalized) {
        return reply
          .status(400)
          .send({ error: "word query parameter is required" });
      }

      const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(normalized.toLowerCase())}`;

      try {
        const response = await fetch(url);
        if (!response.ok) {
          request.log.warn(
            { status: response.status },
            "[dictionary] upstream returned non-ok status",
          );
          return reply.send({ word: normalized, definitions: [] });
        }

        const payload = (await response.json()) as any;

        const definitions: string[] = [];
        if (Array.isArray(payload)) {
          for (const entry of payload) {
            const meanings = entry?.meanings;
            if (!Array.isArray(meanings)) continue;
            for (const meaning of meanings) {
              const defs = meaning?.definitions;
              if (!Array.isArray(defs)) continue;
              for (const def of defs) {
                if (typeof def?.definition === "string") {
                  definitions.push(def.definition as string);
                  if (definitions.length >= 3) break;
                }
              }
              if (definitions.length >= 3) break;
            }
            if (definitions.length >= 3) break;
          }
        }

        return reply.send({ word: normalized, definitions });
      } catch (error) {
        request.log.error({ error }, "[dictionary] lookup failed");
        return reply.send({ word: normalized, definitions: [] });
      }
    },
  );
};

export default dictionaryRoutes;
