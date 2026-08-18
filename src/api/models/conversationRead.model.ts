import mongoose from "mongoose";

const ObjectId = mongoose.Schema.Types.ObjectId;

const conversationReadSchema = new mongoose.Schema(
  {
    conversationId: { type: ObjectId, ref: "Conversation", required: true },
    userId: { type: ObjectId, ref: "User", required: true },
    lastReadAt: { type: Date, required: true },
    lastReadMessageId: {
      type: ObjectId,
      ref: "Message",
      required: false,
    },
    unreadCount: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

conversationReadSchema.index({ conversationId: 1, userId: 1 }, { unique: true });
conversationReadSchema.index({ userId: 1 });

const ConversationRead = mongoose.model("ConversationRead", conversationReadSchema);

export default ConversationRead;
