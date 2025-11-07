import { z } from "zod";

export const chatActionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: {
      type: "string",
      enum: [
        "startTranslation",
        "startUploadFile",
        "viewTranslationStatus",
        "cancelTranslation",
        "startProofread",
        "startQuality",
        "viewQualityReport",
        "openExportPanel",
        "viewTranslatedText",
        "openProofreadTab",
        "describeProofSummary",
        "acknowledge",
        "createProject",
        "applyEditingSuggestion",
        "undoEditingSuggestion",
        "dismissEditingSuggestion",
      ],
    },
    label: { type: ["string", "null"], maxLength: 120 },
    reason: { type: ["string", "null"], maxLength: 320 },
    allowParallel: { type: "boolean" },
    autoStart: { type: "boolean" },
    jobId: { type: ["string", "null"], maxLength: 64 },
    workflowRunId: { type: ["string", "null"], maxLength: 64 },
    suggestionId: { type: ["string", "null"], maxLength: 64 },
  },
  required: [
    "type",
    "label",
    "reason",
    "allowParallel",
    "autoStart",
    "jobId",
    "workflowRunId",
    "suggestionId",
  ],
} as const;

export const chatReplySchema = {
  name: "chat_reply_payload_v1",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      reply: { type: "string", minLength: 1, maxLength: 4_096 },
      actions: {
        type: "array",
        items: chatActionSchema,
        maxItems: 8,
        default: [],
      },
      profileUpdates: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: ["string", "null"], maxLength: 160 },
          author: { type: ["string", "null"], maxLength: 160 },
          context: { type: ["string", "null"], maxLength: 480 },
          translationDirection: {
            type: ["string", "null"],
            maxLength: 120,
          },
          memo: { type: ["string", "null"], maxLength: 640 },
        },
        required: [
          "title",
          "author",
          "context",
          "translationDirection",
          "memo",
        ],
      },
      actionsNote: { type: ["string", "null"], maxLength: 320 },
    },
    required: ["reply", "actions", "profileUpdates", "actionsNote"],
  },
} as const;

export const intentClassifierSchema = {
  name: "chat_intent_payload_v1",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      intent: {
        type: "string",
        enum: [
          "translate",
          "proofread",
          "quality",
          "status",
          "cancel",
          "upload",
          "ebook",
          "other",
        ],
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
      },
      rerun: { type: "boolean" },
      label: { type: ["string", "null"], maxLength: 120 },
      notes: { type: ["string", "null"], maxLength: 200 },
    },
    required: ["intent", "confidence", "rerun", "label", "notes"],
  },
} as const;

export const entityExtractionSchema = {
  name: "chat_entity_payload_v1",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: ["string", "null"], maxLength: 160 },
      author: { type: ["string", "null"], maxLength: 160 },
      context: { type: ["string", "null"], maxLength: 480 },
      translationDirection: { type: ["string", "null"], maxLength: 120 },
      memo: { type: ["string", "null"], maxLength: 640 },
    },
    required: ["title", "author", "context", "translationDirection", "memo"],
  },
} as const;

export const editingAssistantSchema = {
  name: "chat_editing_payload_v1",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      updatedText: { type: "string", minLength: 1 },
      explanation: { type: ["string", "null"], maxLength: 640 },
      warnings: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 200 },
        maxItems: 6,
        default: [],
      },
    },
    required: ["updatedText", "explanation", "warnings"],
  },
} as const;

// ---------------------------------------------------------------------------
// Proofread/translation agent response schemas (v1 & v2)
// ---------------------------------------------------------------------------

export const PROOFREAD_RESPONSE_SCHEMA_NAME = "proofreading_items_schema_v1";
export const PROOFREAD_RESPONSE_SCHEMA_V2_NAME = "proofreading_items_payload_v2_light";

const ProofreadEvidenceSchemaV1 = z
  .object({
    reference: z.enum(["source", "target", "memory", "other"]).optional(),
    quote: z.string(),
    note: z.union([z.string(), z.null()]).optional(),
  })
  .passthrough();

export const ProofreadIssueItemSchemaV1 = z
  .object({
    id: z.string().optional(),
    severity: z.string().optional(),
    issue_ko: z.string().optional(),
    issue_en: z.string().optional(),
    recommendation_ko: z.string().optional(),
    recommendation_en: z.string().optional(),
    rationale_ko: z.string().optional(),
    rationale_en: z.string().optional(),
    confidence: z.number().optional(),
    evidence: z.array(ProofreadEvidenceSchemaV1).optional(),
    spans: z
      .object({
        start: z.number().int().min(0),
        end: z.number().int().min(0),
      })
      .optional()
      .nullable(),
    after: z.union([z.string(), z.null()]).optional(),
    translationExcerpt: z.union([z.string(), z.null()]).optional(),
    kr_sentence_id: z.union([z.number(), z.null()]).optional(),
    en_sentence_id: z.union([z.number(), z.null()]).optional(),
    tags: z.array(z.string()).optional(),
    notes: z
      .object({
        styleGuard: z.array(z.string()).optional(),
        references: z.array(z.string()).optional(),
        guardFindings: z.array(z.unknown()).optional(),
      })
      .optional(),
    translation_segment: z.string().optional(),
    revised_segment: z.string().optional(),
  })
  .passthrough();

export type ProofreadIssueItemV1 = z.infer<typeof ProofreadIssueItemSchemaV1>;

export const ProofreadItemsResponseSchemaV1 = z
  .object({
    version: z.literal("v1").optional(),
    items: z.array(ProofreadIssueItemSchemaV1),
    truncated: z.boolean().optional(),
  })
  .passthrough();

export type ProofreadItemsResponseV1 = z.infer<typeof ProofreadItemsResponseSchemaV1>;

export const proofreadResponseJsonSchemaV1 = {
  type: "object",
  additionalProperties: false,
  properties: {
    version: { type: "string", enum: ["v1"] },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
      },
    },
    truncated: { type: "boolean" },
  },
  required: ["items"],
} as const;

const AgentItemFixSchemaV2 = z
  .object({
    text: z.string().max(2000).optional(),
    note: z.string().max(120).optional(),
  })
  .strict()
  .optional();

export const AgentItemSchemaV2 = z
  .object({
    uid: z.string().min(1).optional(),
    k: z.string().min(1),
    s: z.enum(["error", "warning", "suggestion"]),
    r: z.string().max(320),
    t: z.enum(["replace", "insert", "delete", "note"]),
    i: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
    o: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
    cid: z.string().min(1).optional(),
    rule_id: z.string().min(1).optional(),
    conf: z.number().min(0).max(1).optional(),
    lang: z.string().optional(),
    side: z.enum(["src", "tgt", "both"]).optional(),
    fix: AgentItemFixSchemaV2,
  })
  .strict();

export type AgentItemV2 = z.infer<typeof AgentItemSchemaV2>;

const AgentStatsSchemaV2 = z
  .object({
    item_count: z.number().int().min(0),
    avg_item_bytes: z.number().int().min(0),
  })
  .strict();

const AgentMetricsSchemaV2 = z
  .object({
    downshift_count: z.number().int().min(0),
    forced_pagination: z.boolean(),
    cursor_retry_count: z.number().int().min(0),
  })
  .strict();

export const AgentItemsPayloadSchemaV2 = z
  .object({
    version: z.literal("v2"),
    items: z.array(AgentItemSchemaV2),
    has_more: z.boolean(),
    next_cursor: z.string().nullable(),
    warnings: z.array(z.string()).optional(),
    stats: AgentStatsSchemaV2.optional(),
    index_base: z.union([z.literal(0), z.literal(1)]).optional(),
    offset_semantics: z.literal("[start,end)").optional(),
    partial: z.boolean().optional(),
    segment_hashes: z.array(z.string()).optional(),
    validator_flags: z.record(z.array(z.string())).optional(),
    autoFixesApplied: z.array(z.string()).optional(),
  })
  .strict();

export type AgentItemsPayloadV2 = z.infer<typeof AgentItemsPayloadSchemaV2>;

export const AgentItemsPayloadLightSchemaV2 = z
  .object({
    version: z.literal("v2"),
    items: z.array(
      z
        .object({
          k: z.string().min(1),
          s: z.enum(["error", "warning", "suggestion"]),
          r: z.string().min(1),
          t: z.enum(["replace", "insert", "delete", "note"]),
          span: z
            .object({
              start: z.number().int().min(0),
              end: z.number().int().min(0),
            })
            .strict(),
          fix: z
            .object({
              text: z.string(),
              note: z.string(),
            })
            .strict(),
        })
        .strict(),
    ),
  })
  .strict();

export type AgentItemsPayloadV2Light = z.infer<typeof AgentItemsPayloadLightSchemaV2>;

export const agentItemsPayloadJsonSchemaV2_Light = {
  type: "object",
  additionalProperties: false,
  required: ["version", "items"],
  properties: {
    version: { type: "string", enum: ["v2"] },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["k", "s", "r", "t", "span", "fix"],
        properties: {
          k: { type: "string" },
          s: { type: "string", enum: ["error", "warning", "suggestion"] },
          r: { type: "string" },
          t: { type: "string", enum: ["replace", "insert", "delete", "note"] },
          span: {
            type: "object",
            additionalProperties: false,
            required: ["start", "end"],
            properties: {
              start: { type: "integer", minimum: 0 },
              end: { type: "integer", minimum: 0 },
            },
          },
          fix: {
            type: "object",
            additionalProperties: false,
            required: ["text", "note"],
            properties: {
              text: { type: "string" },
              note: { type: "string" },
            },
          },
        },
      },
    },
  },
} as const;

export const AgentItemsResponseSchemaV2 = z
  .object({
    version: z.literal("v2"),
    run_id: z.string().min(1),
    chunk_id: z.string().min(1),
    tier: z.string().min(1),
    model: z.string().min(1),
    latency_ms: z.number().int().min(0),
    prompt_tokens: z.number().int().min(0),
    completion_tokens: z.number().int().min(0),
    finish_reason: z.enum(["stop", "length", "content_filter", "error"]).optional(),
    truncated: z.boolean(),
    partial: z.boolean().optional(),
    warnings: z.array(z.string()).default([]),
    index_base: z.union([z.literal(0), z.literal(1)]).default(0),
    offset_semantics: z.literal("[start,end)"),
    stats: AgentStatsSchemaV2,
    metrics: AgentMetricsSchemaV2,
    segment_hashes: z.array(z.string()),
    validator_flags: z.record(z.array(z.string())).optional(),
    autoFixesApplied: z.array(z.string()).optional(),
    items: z.array(AgentItemSchemaV2),
    has_more: z.boolean(),
    next_cursor: z.string().nullable(),
    provider_response_id: z.string().nullable(),
  })
  .strict();

export type AgentItemsResponseV2 = z.infer<typeof AgentItemsResponseSchemaV2>;

export const agentItemJsonSchemaV2 = {
  type: "object",
  additionalProperties: false,
  required: ["k", "s", "r", "t", "i", "o"],
  properties: {
    uid: { type: "string" },
    k: { type: "string" },
    s: { type: "string", enum: ["error", "warning", "suggestion"] },
    r: { type: "string" },
    t: { type: "string", enum: ["replace", "insert", "delete", "note"] },
    i: {
      type: "array",
      minItems: 2,
      maxItems: 2,
      items: { type: "integer", minimum: 0 },
    },
    o: {
      type: "array",
      minItems: 2,
      maxItems: 2,
      items: { type: "integer", minimum: 0 },
    },
    cid: { type: "string" },
    rule_id: { type: "string" },
    conf: { type: "number", minimum: 0, maximum: 1 },
    lang: { type: "string" },
    side: { type: "string", enum: ["src", "tgt", "both"] },
    fix: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: { type: "string" },
        note: { type: "string" },
      },
    },
  },
} as const;

export const agentItemsResponseJsonSchemaV2 = {
  type: "object",
  additionalProperties: false,
  required: [
    "version",
    "run_id",
    "chunk_id",
    "tier",
    "model",
    "latency_ms",
    "prompt_tokens",
    "completion_tokens",
    "truncated",
    "index_base",
    "offset_semantics",
    "segment_hashes",
    "items",
    "has_more",
    "next_cursor",
    "stats",
    "metrics",
    "provider_response_id",
  ],
  properties: {
    version: { type: "string", enum: ["v2"] },
    run_id: { type: "string" },
    chunk_id: { type: "string" },
    tier: { type: "string" },
    model: { type: "string" },
    latency_ms: { type: "integer", minimum: 0 },
    prompt_tokens: { type: "integer", minimum: 0 },
    completion_tokens: { type: "integer", minimum: 0 },
    finish_reason: {
      type: "string",
      enum: ["stop", "length", "content_filter", "error"],
    },
    truncated: { type: "boolean" },
    partial: { type: "boolean" },
    warnings: { type: "array", items: { type: "string" } },
    index_base: { type: "integer", enum: [0, 1] },
    offset_semantics: { type: "string", enum: ["[start,end)"] },
    stats: {
      type: "object",
      additionalProperties: false,
      required: ["item_count", "avg_item_bytes"],
      properties: {
        item_count: { type: "integer", minimum: 0 },
        avg_item_bytes: { type: "integer", minimum: 0 },
      },
    },
    metrics: {
      type: "object",
      additionalProperties: false,
      required: [
        "downshift_count",
        "forced_pagination",
        "cursor_retry_count",
      ],
      properties: {
        downshift_count: { type: "integer", minimum: 0 },
        forced_pagination: { type: "boolean" },
        cursor_retry_count: { type: "integer", minimum: 0 },
      },
    },
    items: {
      type: "array",
      items: agentItemJsonSchemaV2,
    },
    segment_hashes: {
      type: "array",
      items: { type: "string" },
    },
    validator_flags: {
      type: "object",
      additionalProperties: {
        type: "array",
        items: { type: "string" },
      },
    },
    autoFixesApplied: {
      type: "array",
      items: { type: "string" },
    },
    has_more: { type: "boolean" },
    next_cursor: { type: ["string", "null"] },
    provider_response_id: { type: ["string", "null"] },
  },
} as const;

export type AgentItemsResponseJsonV2 = typeof agentItemsResponseJsonSchemaV2;

export const proofreadResponseJsonSchemaV2 = agentItemsPayloadJsonSchemaV2_Light;

export type AgentResponseParseResult<TV1> =
  | { version: "v2"; data: AgentItemsPayloadV2 }
  | { version: "v1"; data: TV1 };

export function parseAgentResponse<TV1>(
  payload: unknown,
  v1Schema: z.ZodType<TV1>,
): AgentResponseParseResult<TV1> {
  if (payload && typeof payload === "object") {
    const version = (payload as { version?: unknown }).version;
    if (version === "v2") {
      return {
        version: "v2",
        data: AgentItemsPayloadSchemaV2.parse(payload),
      };
    }
  }

  return {
    version: "v1",
    data: v1Schema.parse(payload),
  };
}
