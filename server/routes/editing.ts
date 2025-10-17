import { randomUUID } from "node:crypto";
import {
  FastifyPluginAsync,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { OpenAI } from "openai";
import { requireAuthAndPlanCheck } from "../middleware/auth";

interface SelectionRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

interface EditingSelectionPayload {
  source: "origin" | "translation";
  text: string;
  rawText?: string | null;
  range: SelectionRange;
  meta?: Record<string, unknown> | null;
}

interface EditingRequestBody {
  selection?: EditingSelectionPayload;
  prompt?: string;
  locale?: string | null;
  context?: Record<string, unknown> | null;
}

type EditingMode = "rewrite" | "normalizeName" | "adjustPronoun";

interface EditingCompletionResult {
  resultText: string;
  explanation: string | null;
  warnings: string[];
  tokens: {
    prompt: number | null;
    completion: number | null;
    total: number | null;
  } | null;
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isSelectionRange = (value: unknown): value is SelectionRange => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SelectionRange>;
  return (
    isFiniteNumber(candidate.startLineNumber) &&
    isFiniteNumber(candidate.startColumn) &&
    isFiniteNumber(candidate.endLineNumber) &&
    isFiniteNumber(candidate.endColumn)
  );
};

const isEditingSelection = (
  value: unknown,
): value is EditingSelectionPayload => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<EditingSelectionPayload>;
  if (candidate.source !== "origin" && candidate.source !== "translation") {
    return false;
  }
  if (typeof candidate.text !== "string" || !candidate.text.trim()) {
    return false;
  }
  if (!isSelectionRange(candidate.range)) {
    return false;
  }
  return true;
};

const REWRITE_PROMPT = `You are a meticulous bilingual editor for the Soongi Pagers literary translation studio. Rewrite the provided passage according to the user's instructions while preserving the original meaning, tense, and voice. Always respond with a JSON object:
{
  "updatedText": string,       // revised passage
  "explanation": string|null,  // <= 2 sentences explaining key changes
  "warnings": string[]         // optional cautions
}

Rules:
- Use the same language as the original selection.
- Keep character names, honorifics, and terminology unless the user explicitly asks to change them.
- Maintain paragraph breaks and inline formatting (quotes, emphasis, ellipses).
- If the instructions conflict or would harm clarity, keep the original text in updatedText and add a warning.
- Never include commentary outside of the JSON payload.`;

const NAME_PROMPT = `You specialize in harmonising character and entity names for translated fiction. Adjust the passage so that names match the user's request while keeping grammar and tone natural. Respond with JSON in the same shape as before. Only alter wording that is necessary to reflect the requested name changes.`;

const PRONOUN_PROMPT = `You adjust pronouns in translated fiction while respecting grammatical agreement and nuance. Update the passage to satisfy the user's pronoun instructions, keeping the rest of the sentence structure intact. Respond with the same JSON shape as above. If you cannot apply the request safely, keep the original text and add a warning explaining why.`;

const getSystemPrompt = (mode: EditingMode): string => {
  switch (mode) {
    case "normalizeName":
      return `${REWRITE_PROMPT}\n${NAME_PROMPT}`;
    case "adjustPronoun":
      return `${REWRITE_PROMPT}\n${PRONOUN_PROMPT}`;
    default:
      return REWRITE_PROMPT;
  }
};

const editingRoutes: FastifyPluginAsync = async (fastify) => {
  const openai = process.env.OPENAI_API_KEY
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;
  const modelId =
    process.env.EDITING_MODEL ??
    process.env.CHAT_MODEL ??
    process.env.SMALL_MODEL ??
    "gpt-4o-mini";

  const runEditingCompletion = async (
    mode: EditingMode,
    body: EditingRequestBody,
  ): Promise<EditingCompletionResult> => {
    if (!openai) {
      throw new Error("LLM is not configured");
    }
    if (!body.selection || !isEditingSelection(body.selection)) {
      throw new Error("Selection payload is missing or invalid");
    }
    const prompt = (body.prompt ?? "").trim();
    if (!prompt) {
      throw new Error("Instruction prompt is required");
    }

    const selection = body.selection;
    const payload = {
      selection: {
        source: selection.source,
        text: selection.text,
        rawText: selection.rawText ?? selection.text,
        range: selection.range,
        meta: selection.meta ?? null,
      },
      instructions: prompt,
      locale: body.locale ?? null,
      context: body.context ?? null,
    };

    const completion = await openai.chat.completions.create({
      model: modelId,
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: getSystemPrompt(mode) },
        {
          role: "user",
          content: JSON.stringify(payload),
        },
      ],
    });

    const content = completion.choices[0]?.message?.content ?? "";
    let updatedText = selection.text;
    let explanation: string | null = null;
    let warnings: string[] = [];

    if (content.trim()) {
      try {
        const parsed = JSON.parse(content) as {
          updatedText?: unknown;
          explanation?: unknown;
          warnings?: unknown;
        };
        if (
          typeof parsed.updatedText === "string" &&
          parsed.updatedText.trim().length
        ) {
          updatedText = parsed.updatedText;
        }
        if (typeof parsed.explanation === "string") {
          const trimmed = parsed.explanation.trim();
          explanation = trimmed.length ? trimmed : null;
        }
        if (Array.isArray(parsed.warnings)) {
          warnings = parsed.warnings
            .filter(
              (item): item is string =>
                typeof item === "string" && item.trim().length > 0,
            )
            .map((item) => item.trim());
        }
      } catch (error) {
        fastify.log.warn(
          { err: error, content },
          "[editing] Failed to parse model response",
        );
        warnings.push("모델 응답을 해석하지 못했습니다.");
      }
    }

    const usage = completion.usage ?? null;

    return {
      resultText: updatedText,
      explanation,
      warnings,
      tokens: usage
        ? {
            prompt: usage.prompt_tokens ?? null,
            completion: usage.completion_tokens ?? null,
            total: usage.total_tokens ?? null,
          }
        : null,
    };
  };

  const buildSchema = {
    body: {
      type: "object",
      required: ["selection", "prompt"],
      properties: {
        selection: {
          type: "object",
          required: ["source", "text", "range"],
          properties: {
            source: { type: "string", enum: ["origin", "translation"] },
            text: { type: "string" },
            rawText: { type: "string" },
            range: {
              type: "object",
              required: [
                "startLineNumber",
                "startColumn",
                "endLineNumber",
                "endColumn",
              ],
              properties: {
                startLineNumber: { type: "number" },
                startColumn: { type: "number" },
                endLineNumber: { type: "number" },
                endColumn: { type: "number" },
              },
            },
            meta: { type: "object", nullable: true },
          },
        },
        prompt: { type: "string" },
        locale: { type: "string", nullable: true },
        context: { type: "object", nullable: true },
      },
    },
    params: {
      type: "object",
      required: ["projectId"],
      properties: {
        projectId: { type: "string" },
      },
    },
  } as const;

  const handleRequest = async (
    mode: EditingMode,
    request: FastifyRequest<{
      Params: { projectId: string };
      Body: EditingRequestBody;
    }>,
    reply: FastifyReply,
  ) => {
    try {
      const result = await runEditingCompletion(mode, request.body as EditingRequestBody);
      return reply.send({
        suggestionId: randomUUID(),
        resultText: result.resultText,
        explanation: result.explanation ?? null,
        warnings: result.warnings,
        tokens: result.tokens,
      });
    } catch (error) {
      request.log.error({ err: error, mode }, "[editing] request failed");
      const message =
        error instanceof Error ? error.message : "Failed to process editing request";
      const status = (() => {
        if (!(error instanceof Error)) return 500;
        const normalized = error.message.toLowerCase();
        if (normalized.includes("invalid") || normalized.includes("required")) {
          return 400;
        }
        if (normalized.includes("not configured")) {
          return 503;
        }
        return 500;
      })();
      return reply.status(status).send({ error: message });
    }
  };

  fastify.post<{ Params: { projectId: string }; Body: EditingRequestBody }>(
    "/api/projects/:projectId/editing/rewrite",
    {
      preHandler: requireAuthAndPlanCheck,
      schema: buildSchema,
    },
    async (request, reply) => handleRequest("rewrite", request, reply),
  );

  fastify.post<{ Params: { projectId: string }; Body: EditingRequestBody }>(
    "/api/projects/:projectId/editing/normalize-name",
    {
      preHandler: requireAuthAndPlanCheck,
      schema: buildSchema,
    },
    async (request, reply) => handleRequest("normalizeName", request, reply),
  );

  fastify.post<{ Params: { projectId: string }; Body: EditingRequestBody }>(
    "/api/projects/:projectId/editing/adjust-pronoun",
    {
      preHandler: requireAuthAndPlanCheck,
      schema: buildSchema,
    },
    async (request, reply) => handleRequest("adjustPronoun", request, reply),
  );
};

export default editingRoutes;
