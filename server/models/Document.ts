import { Schema, model } from "mongoose";
const DocumentSchema = new Schema(
  {
    title: String,
    author: String,
    sourceLang: String,
    content: String,
    tags: [String],
  },
  { timestamps: { createdAt: "createdAt" } },
);
export default model("Document", DocumentSchema);
