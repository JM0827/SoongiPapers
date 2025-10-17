import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import DocumentProfile, {
  type TranslationNotes,
} from "../models/DocumentProfile";
import { query } from "../db";
import { requireAuthAndPlanCheck } from "../middleware/auth";

type ProfileVariant = "origin" | "translation";

const serializeProfile = (doc: any) =>
  doc
    ? {
        id: String(doc._id),
        projectId: doc.project_id,
        type: doc.type as ProfileVariant,
        version: doc.version,
        language: doc.language ?? null,
        jobId: doc.job_id ?? null,
        metrics: doc.metrics,
        summary: doc.summary,
        references: {
          originFileId: doc.origin_file_id ? String(doc.origin_file_id) : null,
          translationFileId: doc.translation_file_id
            ? String(doc.translation_file_id)
            : null,
          qualityAssessmentId: doc.quality_assessment_id
            ? String(doc.quality_assessment_id)
            : null,
          proofreadingId: doc.proofreading_id
            ? String(doc.proofreading_id)
            : null,
        },
        translationNotes: doc.translation_notes ?? null,
        source: {
          hash: doc.source_hash ?? null,
          preview: doc.source_preview ?? null,
        },
        createdAt: doc.created_at ?? doc.createdAt ?? null,
        updatedAt: doc.updated_at ?? doc.updatedAt ?? null,
      }
    : null;

function normalizeVariant(value?: string | null): ProfileVariant | undefined {
  if (!value) return undefined;
  if (value === "origin" || value === "translation") return value;
  return undefined;
}

const documentProfileRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/api/project/:projectId/profiles",
    {
      preHandler: requireAuthAndPlanCheck,
      schema: {
        params: {
          type: "object",
          required: ["projectId"],
          properties: {
            projectId: { type: "string" },
          },
        },
        querystring: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["origin", "translation"] },
            version: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const { type, version } = request.query as {
        type?: string;
        version?: string;
      };
      const userId = (request as any).user_id as string | undefined;

      try {
        const { rows } = await query(
          `SELECT 1 FROM translationprojects WHERE project_id = $1 AND user_id = $2 LIMIT 1`,
          [projectId, userId],
        );
        if (!rows.length) {
          return reply.status(404).send({ error: "Project not found" });
        }
      } catch (err) {
        request.log.error(
          { err },
          "[PROFILE] Failed to validate project ownership",
        );
        return reply.status(500).send({ error: "Failed to validate project" });
      }

      const variant = normalizeVariant(type);
      const wantsSpecificVersion = version && version !== "latest";
      let versionNumber: number | null = null;

      if (wantsSpecificVersion) {
        const parsed = Number.parseInt(version as string, 10);
        if (Number.isNaN(parsed) || parsed <= 0) {
          return reply.status(400).send({ error: "Invalid version" });
        }
        versionNumber = parsed;
      }

      if (!variant && versionNumber !== null) {
        return reply.status(400).send({
          error: "type is required when requesting a specific version",
        });
      }

      if (variant) {
        const filter: Record<string, unknown> = {
          project_id: projectId,
          type: variant,
        };
        if (versionNumber !== null) {
          filter.version = versionNumber;
        }

        const doc =
          versionNumber !== null
            ? await DocumentProfile.findOne(filter).lean().exec()
            : await DocumentProfile.findOne(filter)
                .sort({ version: -1 })
                .lean()
                .exec();

        return reply.send({ profile: serializeProfile(doc) });
      }

      const [originDoc, translationDoc] = await Promise.all([
        DocumentProfile.findOne({ project_id: projectId, type: "origin" })
          .sort({ version: -1 })
          .lean()
          .exec(),
        DocumentProfile.findOne({ project_id: projectId, type: "translation" })
          .sort({ version: -1 })
          .lean()
          .exec(),
      ]);

      return reply.send({
        profiles: {
          origin: serializeProfile(originDoc),
          translation: serializeProfile(translationDoc),
        },
      });
    },
  );

  const translationNotesSchema = z
    .object({
      characters: z
        .array(
          z.object({
            name: z.string().min(1).max(200),
            age: z.string().trim().max(120).optional().nullable(),
          gender: z.string().trim().max(120).optional().nullable(),
          traits: z
            .array(z.string().trim().min(1).max(160))
            .max(10)
            .optional(),
        }),
      )
      .max(50)
      .optional(),
    namedEntities: z
      .array(
        z.object({
          name: z.string().min(1).max(200),
          frequency: z.number().int().min(0).max(1_000_000).optional(),
        }),
      )
      .max(50)
      .optional(),
    timePeriod: z.string().trim().max(200).optional().nullable(),
    locations: z
      .array(
        z.object({
          name: z.string().min(1).max(200),
          frequency: z.number().int().min(0).max(1_000_000).optional(),
        }),
      )
      .max(50)
      .optional(),
    measurementUnits: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
    linguisticFeatures: z.array(z.string().trim().min(1).max(160)).max(50).optional(),
    })
    .strict();

  const updateNotesSchema = z.object({
    translationNotes: translationNotesSchema.nullable(),
  });

  fastify.put(
    "/api/project/:projectId/profiles/origin/translation-notes",
    {
      preHandler: requireAuthAndPlanCheck,
      schema: {
        params: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const userId = (request as any).user_id as string | undefined;

      const parsed = updateNotesSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Invalid translation notes payload",
          issues: parsed.error.issues,
        });
      }

      try {
        const { rows } = await query(
          `SELECT 1 FROM translationprojects WHERE project_id = $1 AND user_id = $2 LIMIT 1`,
          [projectId, userId],
        );
        if (!rows.length) {
          return reply.status(404).send({ error: "Project not found" });
        }
      } catch (err) {
        request.log.error({ err }, "[PROFILE] Failed to validate project ownership");
        return reply.status(500).send({ error: "Failed to validate project" });
      }

      const latestOriginProfile = await DocumentProfile.findOne({
        project_id: projectId,
        type: "origin",
      })
        .sort({ version: -1 })
        .exec();

      if (!latestOriginProfile) {
        return reply
          .status(404)
          .send({ error: "Origin profile not found for project" });
      }

      const sanitizeString = (value?: string | null) => {
        const trimmed = value?.trim();
        return trimmed && trimmed.length ? trimmed : null;
      };

      const sanitizeList = (values?: string[] | null) =>
        Array.isArray(values)
          ? values
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0)
          : [];

      const toNotes = (input: typeof parsed.data.translationNotes): TranslationNotes | null => {
        if (!input) return null;
        const characters = (input.characters ?? [])
          .map((character) => {
            const name = character.name.trim();
            if (!name) return null;
            return {
              name,
              age: sanitizeString(character.age) ?? null,
              gender: sanitizeString(character.gender) ?? null,
              traits: sanitizeList(character.traits),
            };
          })
          .filter((character): character is TranslationNotes["characters"][number] =>
            Boolean(character),
          );

        const mapEntities = (values?: typeof input.namedEntities) =>
          (values ?? [])
            .map((entity) => {
              const name = entity.name.trim();
              if (!name) return null;
              const frequency = Number.isFinite(entity.frequency)
                ? Math.max(0, Number(entity.frequency))
                : 0;
              return { name, frequency };
            })
            .filter((entity): entity is TranslationNotes["namedEntities"][number] =>
              Boolean(entity),
            );

        const namedEntities = mapEntities(input.namedEntities);
        const locations = mapEntities(input.locations);
        const measurementUnits = sanitizeList(input.measurementUnits);
        const linguisticFeatures = sanitizeList(input.linguisticFeatures);
        const timePeriod = sanitizeString(input.timePeriod);

        if (
          !characters.length &&
          !namedEntities.length &&
          !locations.length &&
          !measurementUnits.length &&
          !linguisticFeatures.length &&
          !timePeriod
        ) {
          return null;
        }

        return {
          characters,
          namedEntities,
          locations,
          measurementUnits,
          linguisticFeatures,
          timePeriod,
        };
      };

      const nextNotes = toNotes(parsed.data.translationNotes);

      latestOriginProfile.set("translation_notes", nextNotes ?? null);
      latestOriginProfile.markModified("translation_notes");
      await latestOriginProfile.save();

      return reply.send({
        profile: serializeProfile(latestOriginProfile.toObject()),
      });
    },
  );
};

export default documentProfileRoutes;
