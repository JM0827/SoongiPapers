import { Schema, model, type Types } from "mongoose";

const TranslationDraftSegmentSchema = new Schema(
  {
    segment_id: { type: String, required: true },
    origin_segment: { type: String, required: true },
    translation_segment: { type: String, required: true },
    notes: { type: [String], default: [] },
  },
  { _id: false },
);

const TranslationDraftSchema = new Schema(
  {
    project_id: { type: String, required: true, index: true },
    job_id: { type: String, required: true, index: true },
    workflow_run_id: { type: String, default: null, index: true },
    run_order: { type: Number, required: true },
    source_hash: { type: String, required: true },
    status: {
      type: String,
      enum: ["queued", "running", "succeeded", "failed", "cancelled"],
      default: "queued",
      index: true,
    },
    error: { type: String, default: null },
    model: { type: String, default: null },
    temperature: { type: Number, default: null },
    top_p: { type: Number, default: null },
    verbosity: { type: String, default: null },
    reasoning_effort: { type: String, default: null },
    max_output_tokens: { type: Number, default: null },
    retry_count: { type: Number, default: 0 },
    truncated: { type: Boolean, default: false },
    fallback_model_used: { type: Boolean, default: false },
    usage: {
      input_tokens: { type: Number, default: 0 },
      output_tokens: { type: Number, default: 0 },
    },
    segments: { type: [TranslationDraftSegmentSchema], default: [] },
    merged_text: { type: String, default: "" },
    metadata: { type: Schema.Types.Mixed, default: {} },
    started_at: { type: Date, default: null },
    finished_at: { type: Date, default: null },
  },
  {
    collection: "translation_drafts",
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  },
);

TranslationDraftSchema.index(
  { project_id: 1, job_id: 1, run_order: 1 },
  { unique: true },
);

export interface TranslationDraftSegmentDocument {
  segment_id: string;
  origin_segment: string;
  translation_segment: string;
  notes: string[];
}

export interface TranslationDraftDocument {
  _id: Types.ObjectId;
  project_id: string;
  job_id: string;
  workflow_run_id: string | null;
  run_order: number;
  source_hash: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  error: string | null;
  model: string | null;
  temperature: number | null;
  top_p: number | null;
  verbosity: string | null;
  reasoning_effort: string | null;
  max_output_tokens: number | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  retry_count: number;
  truncated: boolean;
  fallback_model_used: boolean;
  segments: TranslationDraftSegmentDocument[];
  merged_text: string;
  metadata: Record<string, unknown>;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export default model<TranslationDraftDocument>(
  "TranslationDraft",
  TranslationDraftSchema,
);
