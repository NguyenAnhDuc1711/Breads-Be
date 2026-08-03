import mongoose from "mongoose";

const ObjectId = mongoose.Schema.Types.ObjectId;

const conversationSchema = new mongoose.Schema(
  {
    participants: [{ type: ObjectId, ref: "User" }],
    msgIds: [
      {
        type: ObjectId,
        ref: "Message",
        required: false,
      },
    ],
    theme: {
      type: String,
      default: "default",
    },
    emoji: {
      type: String,
      default: ":thumbsup:",
    },
    lastMsgId: {
      type: ObjectId,
      ref: "Message",
      required: false,
    },
  },
  { timestamps: true }
);

const Conversation = mongoose.model("Conversation", conversationSchema);

export default Conversation;
