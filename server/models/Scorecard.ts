import { Schema, model } from "mongoose";
const ScorecardSchema = new Schema(
  {
    documentId: { type: Schema.Types.ObjectId, ref: "Document", index: true },
    translationId: {
      type: Schema.Types.ObjectId,
      ref: "Translation",
      index: true,
    },
    rubric: {
      intent: Number,
      faithful: Number,
      expression: Number,
      naturalness: Number,
      consistency: Number,
      resonance: Number,
      literary: Number,
    },
    overall: Number,
    comments: String,
    version: { type: Number, default: 1 },
  },
  { timestamps: { createdAt: "createdAt" } },
);
export default model("Scorecard", ScorecardSchema);
