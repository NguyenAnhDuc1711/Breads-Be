import mongoose from "mongoose";

const ObjectId = mongoose.Schema.Types.ObjectId;

const notificationSchema = new mongoose.Schema(
  {
    fromUser: {
      type: ObjectId,
      ref: "User",
      required: true,
    },
    toUsers: [
      {
        type: ObjectId,
        ref: "User",
        required: true,
      },
    ],
    action: {
      type: String,
      required: true,
    },
    target: {
      type: ObjectId,
      ref: "Post",
      required: false,
    },
    isRead: { type: Boolean, default: false },
  },
  {
    timestamps: true,
  }
);

notificationSchema.index({ toUsers: 1, createdAt: -1 });

const Notification = mongoose.model("Notification", notificationSchema);

export default Notification;
