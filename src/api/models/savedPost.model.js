import mongoose from "mongoose";

const ObjectId = mongoose.Schema.Types.ObjectId;

// Replaces the old Collection.postsId embedded array — a real per-save
// record is required to sort "Saved" by the time each post was actually
// saved (the array had no per-item timestamp, only insertion order).
const savedPostSchema = mongoose.Schema(
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
