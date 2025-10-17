import mongoose from "mongoose";

const ChatMessageSchema = new mongoose.Schema(
  {
    project_id: { type: String, required: true, index: true },
    role: {
      type: String,
      enum: ["assistant", "user", "system"],
      required: true,
    },
    content: { type: String, required: true },
    actions: { type: [mongoose.Schema.Types.Mixed], default: [] },
    metadata: { type: mongoose.Schema.Types.Mixed },
    created_at: { type: Date, default: Date.now, index: true },
  },
  {
    collection: "chat_messages",
  },
);

export type ChatMessageDocument = mongoose.InferSchemaType<
  typeof ChatMessageSchema
>;

export default (mongoose.models
  .ChatMessage as mongoose.Model<ChatMessageDocument>) ||
  mongoose.model<ChatMessageDocument>("ChatMessage", ChatMessageSchema);
