import mongoose from "mongoose";

const EbookFileSchema = new mongoose.Schema(
  {
    ebook_id: { type: String, required: true, unique: true },
    project_id: { type: String, required: true, index: true },
    translation_file_id: { type: String, required: true },
    format: { type: String, default: "txt" },
    filename: { type: String, required: true },
    size: { type: Number, required: true },
    mime_type: { type: String, default: "text/plain" },
    content: { type: Buffer, required: true },
    recommended_quality_assessment_id: { type: String },
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now },
  },
  { collection: "ebook_files" },
);

EbookFileSchema.pre("save", function (next) {
  this.updated_at = new Date();
  next();
});

export type EbookFileDocument = mongoose.InferSchemaType<
  typeof EbookFileSchema
>;

export default (mongoose.models
  .EbookFile as mongoose.Model<EbookFileDocument>) ||
  mongoose.model<EbookFileDocument>("EbookFile", EbookFileSchema);
