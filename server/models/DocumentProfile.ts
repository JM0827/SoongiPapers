import { Schema, model, type Types } from "mongoose";

type DocumentProfileType = "origin" | "translation";

const MetricsSchema = new Schema(
  {
    wordCount: { type: Number, required: true, default: 0 },
    charCount: { type: Number, required: true, default: 0 },
    paragraphCount: { type: Number, required: true, default: 0 },
    readingTimeMinutes: { type: Number, required: true, default: 0 },
    readingTimeLabel: { type: String, required: true, default: "" },
  },
  { _id: false },
);

const SummarySchema = new Schema(
  {
    story: { type: String, required: true, default: "" },
    intention: { type: String, required: true, default: "" },
    readerPoints: { type: [String], required: true, default: [] },
  },
  { _id: false },
);

const TranslationCharacterSchema = new Schema(
  {
    name: { type: String, required: true, default: "" },
    targetName: { type: String, default: null },
    age: { type: String, default: null },
    gender: { type: String, default: null },
    traits: { type: [String], default: [] },
  },
  { _id: false },
);

const TranslationEntitySchema = new Schema(
  {
    name: { type: String, required: true, default: "" },
    targetName: { type: String, default: null },
    frequency: { type: Number, default: 0 },
  },
  { _id: false },
);

const BilingualValueSchema = new Schema(
  {
    source: { type: String, required: true, default: "" },
    target: { type: String, default: null },
  },
  { _id: false },
);

const TranslationNotesSchema = new Schema(
  {
    characters: { type: [TranslationCharacterSchema], default: [] },
    namedEntities: { type: [TranslationEntitySchema], default: [] },
    locations: { type: [TranslationEntitySchema], default: [] },
    timePeriod: { type: String, default: null },
    measurementUnits: { type: [BilingualValueSchema], default: [] },
    linguisticFeatures: { type: [BilingualValueSchema], default: [] },
  },
  { _id: false },
);

const DocumentProfileSchema = new Schema(
  {
    project_id: { type: String, required: true, index: true },
    type: { type: String, required: true, enum: ["origin", "translation"] },
    version: { type: Number, required: true },
    language: { type: String, default: null },
    job_id: { type: String, default: null },
    origin_file_id: {
      type: Schema.Types.ObjectId,
      ref: "OriginFile",
      default: null,
    },
    translation_file_id: {
      type: Schema.Types.ObjectId,
      ref: "TranslationFile",
      default: null,
    },
    quality_assessment_id: {
      type: Schema.Types.ObjectId,
      ref: "QualityAssessment",
      default: null,
    },
    proofreading_id: {
      type: Schema.Types.ObjectId,
      ref: "Proofreading",
      default: null,
    },
    metrics: { type: MetricsSchema, required: true },
    summary: { type: SummarySchema, required: true },
    translation_notes: {
      type: TranslationNotesSchema,
      default: null,
    },
    source_hash: { type: String, default: null },
    source_characters: { type: Number, default: null },
    source_preview: { type: String, default: null },
  },
  {
    collection: "document_profiles",
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  },
);

DocumentProfileSchema.index(
  { project_id: 1, type: 1, version: -1 },
  { unique: true },
);

export type DocumentProfileDocument = {
  _id: Types.ObjectId;
  project_id: string;
  type: DocumentProfileType;
  version: number;
  language?: string | null;
  job_id?: string | null;
  origin_file_id?: Types.ObjectId | null;
  translation_file_id?: Types.ObjectId | null;
  quality_assessment_id?: Types.ObjectId | null;
  proofreading_id?: Types.ObjectId | null;
  metrics: {
    wordCount: number;
    charCount: number;
    paragraphCount: number;
    readingTimeMinutes: number;
    readingTimeLabel: string;
  };
  summary: {
    story: string;
    intention: string;
    readerPoints: string[];
  };
  translation_notes?: {
    characters: Array<{
      name: string;
      targetName: string | null;
      age: string | null;
      gender: string | null;
      traits: string[];
    }>;
    namedEntities: Array<{ name: string; targetName: string | null; frequency: number }>;
    timePeriod: string | null;
    locations: Array<{ name: string; targetName: string | null; frequency: number }>;
    measurementUnits: Array<{ source: string; target: string | null }>;
    linguisticFeatures: Array<{ source: string; target: string | null }>;
  } | null;
  source_hash?: string | null;
  source_characters?: number | null;
  source_preview?: string | null;
  created_at: Date;
  updated_at: Date;
};

export default model("DocumentProfile", DocumentProfileSchema);

export type TranslationNotes = NonNullable<
  DocumentProfileDocument["translation_notes"]
>;

export type TranslationMeasurementEntry = TranslationNotes["measurementUnits"][number];

const toNullableString = (value: unknown): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return null;
};

const normalizeBilingualList = (value: unknown, limit = 50) => {
  if (!value) return [] as TranslationMeasurementEntry[];
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .map((entry) => {
      if (typeof entry === "string") {
        const source = entry.trim();
        if (!source) return null;
        return { source, target: null } satisfies TranslationMeasurementEntry;
      }
      if (entry && typeof entry === "object") {
        const source = toNullableString(
          (entry as Record<string, unknown>).source ??
            (entry as Record<string, unknown>).name,
        );
        if (!source) return null;
        const target = toNullableString(
          (entry as Record<string, unknown>).target ??
            (entry as Record<string, unknown>).targetName,
        );
        return { source, target: target ?? null } satisfies TranslationMeasurementEntry;
      }
      return null;
    })
    .filter((entry): entry is TranslationMeasurementEntry => Boolean(entry))
    .slice(0, limit);
};

export function normalizeTranslationNotes(
  raw: unknown,
): TranslationNotes | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;

  const characters = Array.isArray(source.characters)
    ? source.characters
        .map((entry: unknown) => {
          const name = toNullableString((entry as any)?.name) ?? "";
          if (!name) return null;
          const targetName = toNullableString((entry as any)?.targetName);
          const age = toNullableString((entry as any)?.age);
          const gender = toNullableString((entry as any)?.gender);
          const traits = Array.isArray((entry as any)?.traits)
            ? (entry as any).traits
                .map((trait: unknown) => toNullableString(trait))
                .filter((trait: string | null): trait is string => Boolean(trait))
            : [];
          return { name, targetName: targetName ?? null, age, gender, traits };
        })
        .filter((entry): entry is TranslationNotes["characters"][number] =>
          Boolean(entry),
        )
    : [];

  const mapEntity = (entry: unknown) => {
    const name = toNullableString((entry as any)?.name) ?? "";
    if (!name) return null;
    const targetName = toNullableString((entry as any)?.targetName);
    const frequency = Number.isFinite((entry as any)?.frequency)
      ? Math.max(0, Number((entry as any).frequency))
      : 0;
    return {
      name,
      targetName: targetName ?? null,
      frequency,
    } satisfies TranslationNotes["namedEntities"][number];
  };

  const namedEntities = Array.isArray(source.namedEntities)
    ? source.namedEntities
        .map(mapEntity)
        .filter((entry): entry is TranslationNotes["namedEntities"][number] =>
          Boolean(entry),
        )
    : [];

  const locations = Array.isArray(source.locations)
    ? source.locations
        .map(mapEntity)
        .filter((entry): entry is TranslationNotes["locations"][number] =>
          Boolean(entry),
        )
    : [];

  const measurementUnits = normalizeBilingualList(source.measurementUnits);
  const linguisticFeatures = normalizeBilingualList(source.linguisticFeatures);
  const timePeriod = toNullableString(source.timePeriod);

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
}
