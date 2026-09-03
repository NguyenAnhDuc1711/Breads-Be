import mongoose from "mongoose";

const ObjectId = mongoose.Schema.Types.ObjectId;

const likeSchema = new mongoose.Schema(
  {
    postId: {
      type: ObjectId,
      ref: "Post",
      required: true,
    },
    userId: {
      type: ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

likeSchema.index({ postId: 1, userId: 1 }, { unique: true });
likeSchema.index({ userId: 1, createdAt: -1 });

const Like = mongoose.model("Like", likeSchema);

export default Like;
