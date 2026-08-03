import mongoose from "mongoose";

const ObjectId = mongoose.Schema.Types.ObjectId;

const followSchema = mongoose.Schema(
  {
    followerId: {
      type: ObjectId,
      ref: "User",
      required: true,
    },
    followeeId: {
      type: ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

followSchema.index({ followerId: 1, followeeId: 1 }, { unique: true });
followSchema.index({ followeeId: 1 });

const Follow = mongoose.model("Follow", followSchema);

export default Follow;
