import mongoose from "mongoose";

const OriginFileSchema = new mongoose.Schema(
  {
    project_id: { type: String, required: true, index: true },
    job_id: { type: String, required: true, index: true },
    file_type: { type: String, default: "txt" },
    file_size: { type: Number, default: 0 },
    original_filename: { type: String, default: null },
    original_extension: { type: String, default: null },
    mime_type: { type: String, default: null },
    extraction_method: { type: String, default: null },
    word_count: { type: Number, default: 0 },
    character_count: { type: Number, default: 0 },
    binary_content: { type: Buffer, default: null },
    text_content: { type: String, default: "" },
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now },
  },
  { collection: "origin_files" },
);

OriginFileSchema.pre("save", function (next) {
  this.updated_at = new Date();
  next();
});

export type OriginFileDocument = mongoose.InferSchemaType<
  typeof OriginFileSchema
>;

export default (mongoose.models
  .OriginFile as mongoose.Model<OriginFileDocument>) ||
  mongoose.model<OriginFileDocument>("OriginFile", OriginFileSchema);
