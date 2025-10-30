import { readFile } from "fs/promises";
import { z } from "zod";

export const SeveritySchema = z.enum(["low", "medium", "high"]);

export type ResponseVerbositySetting = "low" | "medium" | "high";
export type ReasoningEffortSetting = "minimal" | "low" | "medium" | "high";

const GuardFindingSchema = z.object({
  type: z.string(),
  summary: z.string(),
  severity: z.string().optional(),
  segmentId: z.string().optional(),
  details: z.record(z.any()).optional(),
  needsReview: z.boolean().optional(),
});

const EvidenceSchema = z.object({
  reference: z.enum(["source", "target", "memory", "other"]).default("source"),
  quote: z.string(),
  note: z.string().optional(),
});

export const IssueItemSchema = z.object({
  id: z.string(),
  kr_sentence_id: z.number().nullable(),
  en_sentence_id: z.number().nullable(),
  issue_ko: z.string(),
  issue_en: z.string(),
  recommendation_ko: z.string(),
  recommendation_en: z.string(),
  before: z.string().optional(),
  after: z.string(),
  alternatives: z.array(z.string()).optional(),
  rationale_ko: z.string(),
  rationale_en: z.string(),
  spans: z.object({ start: z.number(), end: z.number() }).nullable().optional(),
  confidence: z.number().min(0).max(1),
  severity: SeveritySchema,
  tags: z.array(z.string()).optional(),
  source: z.string().optional(),
  sourceExcerpt: z.string().optional(),
  translationExcerpt: z.string().optional(),
  guardStatus: z.enum(["qa_also", "llm_only", "guard_only"]).optional(),
  guardStatusLabel: z.string().optional(),
  status: z.enum(["pending", "applied"]).optional(),
  appliedAt: z.string().nullable().optional(),
  evidence: z.array(EvidenceSchema).min(1),
  notes: z
    .object({
      styleGuard: z.array(z.string()).optional(),
      references: z.array(z.string()).optional(),
      guardFindings: z.array(GuardFindingSchema).optional(),
    })
    .optional(),
});
export type IssueItem = z.infer<typeof IssueItemSchema>;
export type GuardFinding = z.infer<typeof GuardFindingSchema>;
export type IssueEvidence = z.infer<typeof EvidenceSchema>;

export const TierSchema = z.enum(["quick", "deep"]);

export type Tier = z.infer<typeof TierSchema>;

export const SubfeatureSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  enabled: z.boolean().default(true),
  tier: TierSchema.default("quick"),
  model: z.string().min(1).optional(),
  prompt: z.object({
    system: z.string().min(1),
    style_guides: z.array(z.string()).optional(),
  }),
});
export const GroupSchema = z.object({
  name: z.string().min(1),
  subfeatures: z.array(SubfeatureSchema).nonempty(),
});
export const SpecSchema = z.object({
  schemaVersion: z.literal("1.0"),
  language: z.object({ source: z.string().min(2), target: z.string().min(2) }),
  runtime: z
    .object({
      maxWorkers: z.number().int().min(1).max(64).default(4),
      maxCharsPerChunk: z.number().int().min(500).max(8000).default(2000),
      aligner: z.enum(["greedy", "simple", "embeddings"]).default("greedy"),
      quickChunkSize: z.number().int().min(1).max(12).default(4),
      deepChunkSize: z.number().int().min(1).max(12).default(2),
      debugLogging: z.boolean().optional(),
    })
    .default({
      maxWorkers: 4,
      maxCharsPerChunk: 2000,
      aligner: "greedy",
      quickChunkSize: 4,
      deepChunkSize: 2,
      debugLogging: false,
    }),
  groups: z.array(GroupSchema).nonempty(),
});

export type Spec = z.infer<typeof SpecSchema>;
export type Subfeature = z.infer<typeof SubfeatureSchema>;
export type Group = z.infer<typeof GroupSchema>;

export type ResultBucket = {
  group: string;
  subfeatureKey: string;
  subfeatureLabel: string;
  items: IssueItem[];
};

export type ProofreadingLLMRunMeta = {
  tier: Tier;
  subfeatureKey: string;
  subfeatureLabel: string;
  chunkIndex: number;
  model: string;
  maxOutputTokens: number;
  attempts: number;
  truncated: boolean;
  requestId: string | null;
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  };
  verbosity: ResponseVerbositySetting;
  reasoningEffort: ReasoningEffortSetting;
  guardSegments: number;
  memoryContextVersion: number | null;
};

export type ProofreadingReport = {
  meta: {
    schemaVersion: "1.0";
    source: { lang: string; path: string };
    target: { lang: string; path: string };
    alignment: "sentence" | "paragraph";
    generatedAt: string;
    llm?: { runs: ProofreadingLLMRunMeta[] };
  };
  results: ResultBucket[];
  summary: {
    countsBySubfeature: Record<string, number>;
    notes_ko?: string;
    notes_en?: string;
  };
};

export async function loadSpec(specPath: string): Promise<Spec> {
  const raw = await readFile(specPath, "utf-8");
  const json = JSON.parse(raw);
  const parsed = SpecSchema.parse(json);
  const keys = new Set<string>();
  for (const g of parsed.groups) {
    for (const sf of g.subfeatures) {
      if (keys.has(sf.key))
        throw new Error(`Duplicated subfeature.key: ${sf.key}`);
      keys.add(sf.key);
    }
  }
  return parsed;
}
