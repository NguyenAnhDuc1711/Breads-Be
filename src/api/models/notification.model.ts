import mongoose from "mongoose";

const ObjectId = mongoose.Schema.Types.ObjectId;

const notificationSchema = mongoose.Schema(
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
  },
  {
    timestamps: true,
  }
);

const Notification = mongoose.model("Notification", notificationSchema);

export default Notification;
