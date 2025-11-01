import { Schema, model } from "mongoose";

const QualityAssessmentSchema = new Schema(
  {
    projectId: { type: String, required: true, index: true },
    jobId: { type: String },
    assessmentId: { type: String, required: true, unique: true, index: true },
    timestamp: { type: Date, default: Date.now, index: true },
    sourceText: { type: String, required: true },
    translatedText: { type: String, required: true },
    qualityResult: { type: Schema.Types.Mixed, required: true },
    translationMethod: {
      type: String,
      enum: ["auto", "manual"],
      default: "auto",
    },
    modelUsed: {
      type: String,
      default:
        process.env.QUALITY_MODEL ||
        process.env.LITERARY_QA_MODEL ||
        process.env.TRANSLATION_DRAFT_MODEL_V2 ||
        process.env.TRANSLATION_DRAFT_MODEL ||
        process.env.CHAT_MODEL ||
        "gpt-4o",
    },
    userId: { type: String, required: true, index: true },
  },
  {
    collection: "quality_assessments",
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  },
);

// 복합 인덱스 설정
QualityAssessmentSchema.index({ projectId: 1, userId: 1, timestamp: -1 });
QualityAssessmentSchema.index({ userId: 1, timestamp: -1 });

export default model("QualityAssessment", QualityAssessmentSchema);
