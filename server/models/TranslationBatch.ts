import { Schema, model } from "mongoose";

const TranslationBatchSchema = new Schema(
  {
    job_id: { type: String, required: true, index: true },
    batch_index: { type: Number, required: true },
    original_text: { type: String, required: true },
    translated_text: { type: String },
    status: {
      type: String,
      enum: ["queued", "running", "done", "failed"],
      default: "queued",
    },
    error: { type: String },
    started_at: { type: Date },
    finished_at: { type: Date },
  },
  {
    collection: "translation_batches",
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  },
);

export default model("TranslationBatch", TranslationBatchSchema);
