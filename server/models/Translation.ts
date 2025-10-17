import { Schema, model } from "mongoose";
const TranslationSchema = new Schema(
  {
    documentId: { type: Schema.Types.ObjectId, ref: "Document", index: true },
    targetLang: { type: String, default: "en" },
    text: String,
    altPhrases: [{ orig: String, alts: [String] }],
    notes: String,
    version: { type: Number, default: 1 },
  },
  { timestamps: { createdAt: "createdAt" } },
);
export default model("Translation", TranslationSchema);
