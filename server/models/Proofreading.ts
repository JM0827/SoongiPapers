import { Schema, model } from "mongoose";

const ProofreadingSchema = new Schema(
  {
    project_id: { type: String, required: true, index: true },
    job_id: { type: String, required: true, index: true },
    status: { type: String, required: true },
    applied_proofreading: { type: Boolean, default: false },
    translated_text: { type: String },
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now },
  },
  {
    collection: "proofreading_files",
  },
);

ProofreadingSchema.index({ project_id: 1, job_id: 1 });

export default model("Proofreading", ProofreadingSchema);
