import { Schema, model } from "mongoose";

const TranslationFileSchema = new Schema(
  {
    project_id: { type: String, required: true, index: true },
    job_id: { type: String, required: true, index: true },

    variant: {
      type: String,
      enum: ["draft", "final"],
      default: "final",
      index: true,
    },
    is_final: { type: Boolean, default: true, index: true },
    source_hash: { type: String, default: null },
    synthesis_draft_ids: {
      type: [Schema.Types.ObjectId],
      ref: "TranslationDraft",
      default: [],
    },
    segments_version: { type: Number, default: 1 },

    // Origin 파일 정보
    origin_filename: { type: String, required: true },
    origin_file_size: { type: Number, required: true },
    origin_content: { type: String, required: true },

    // Translation 정보
    translated_content: { type: String, required: true },
    batch_count: { type: Number, required: true },
    completed_batches: { type: Number, required: true },

    // 메타데이터
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now },
    completed_at: { type: Date, required: true },
  },
  {
    collection: "translation_files",
  },
);

// 복합 인덱스 설정
TranslationFileSchema.index({ project_id: 1, completed_at: -1 }); // 최신 조회용
TranslationFileSchema.index({ project_id: 1, job_id: 1 }, { unique: true }); // 중복 방지

export default model("TranslationFile", TranslationFileSchema);
