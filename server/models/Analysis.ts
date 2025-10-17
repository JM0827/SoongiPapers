import { Schema, model } from "mongoose";
const AnalysisSchema = new Schema(
  {
    documentId: { type: Schema.Types.ObjectId, ref: "Document", index: true },
    passes: {
      intent: String,
      style: String,
      tone: String,
      culturalNotes: String,
    },
    entities: [{ type: { type: String }, value: String, score: Number }],
    duplicates: [{ text: String, count: Number }],
    checklist: {
      intentCapture: Boolean,
      faithfulMeaning: Boolean,
      expression: Boolean,
      naturalness: Boolean,
      consistency: Boolean,
      culturalResonance: Boolean,
      literaryQuality: Boolean,
    },
    version: { type: Number, default: 1 },
  },
  { timestamps: { createdAt: "createdAt" } },
);
export default model("Analysis", AnalysisSchema);
