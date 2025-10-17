import { Schema, model, type Types } from "mongoose";

const TranslationSegmentSchema = new Schema(
  {
    project_id: { type: String, required: true, index: true },
    translation_file_id: {
      type: Schema.Types.ObjectId,
      ref: "TranslationFile",
      required: true,
      index: true,
    },
    job_id: { type: String, default: null, index: true },
    variant: {
      type: String,
      enum: ["draft", "final"],
      default: "draft",
      index: true,
    },
    segment_id: { type: String, required: true },
    segment_index: { type: Number, required: true },
    origin_segment: { type: String, required: true },
    translation_segment: { type: String, required: true },
    source_draft_ids: {
      type: [Schema.Types.ObjectId],
      default: [],
      ref: "TranslationDraft",
    },
    synthesis_notes: { type: Schema.Types.Mixed, default: {} },
  },
  {
    collection: "translation_segments",
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  },
);

TranslationSegmentSchema.index(
  { project_id: 1, translation_file_id: 1, segment_index: 1 },
  { unique: true },
);

export interface TranslationSegmentDocument {
  _id: Types.ObjectId;
  project_id: string;
  translation_file_id: Types.ObjectId;
  job_id: string | null;
  variant: "draft" | "final";
  segment_id: string;
  segment_index: number;
  origin_segment: string;
  translation_segment: string;
  source_draft_ids: Types.ObjectId[];
  synthesis_notes: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export default model<TranslationSegmentDocument>(
  "TranslationSegment",
  TranslationSegmentSchema,
);
