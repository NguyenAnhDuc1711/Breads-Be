import mongoose from "mongoose";

const ObjectId = mongoose.Schema.Types.ObjectId;

const savedPostSchema = new mongoose.Schema(
  {
    userId: {
      type: ObjectId,
      ref: "User",
      required: true,
    },
    postId: {
      type: ObjectId,
      ref: "Post",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

savedPostSchema.index({ userId: 1, postId: 1 }, { unique: true });
savedPostSchema.index({ userId: 1, createdAt: -1 });

const SavedPost = mongoose.model("SavedPost", savedPostSchema);

export default SavedPost;
