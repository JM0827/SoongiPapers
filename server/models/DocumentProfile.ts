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
    age: { type: String, default: null },
    gender: { type: String, default: null },
    traits: { type: [String], default: [] },
  },
  { _id: false },
);

const TranslationEntitySchema = new Schema(
  {
    name: { type: String, required: true, default: "" },
    frequency: { type: Number, default: 0 },
  },
  { _id: false },
);

const TranslationNotesSchema = new Schema(
  {
    characters: { type: [TranslationCharacterSchema], default: [] },
    namedEntities: { type: [TranslationEntitySchema], default: [] },
    timePeriod: { type: String, default: null },
    locations: { type: [TranslationEntitySchema], default: [] },
    measurementUnits: { type: [String], default: [] },
    linguisticFeatures: { type: [String], default: [] },
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
      age: string | null;
      gender: string | null;
      traits: string[];
    }>;
    namedEntities: Array<{ name: string; frequency: number }>;
    timePeriod: string | null;
    locations: Array<{ name: string; frequency: number }>;
    measurementUnits: string[];
    linguisticFeatures: string[];
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
