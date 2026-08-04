import mongoose from "mongoose";

const ObjectId = mongoose.Schema.Types.ObjectId;

const blockSchema = new mongoose.Schema(
  {
    blockerId: {
      type: ObjectId,
      ref: "User",
      required: true,
    },
    blockedId: {
      type: ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

blockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });
blockSchema.index({ blockedId: 1 });

const Block = mongoose.model("Block", blockSchema);

export default Block;
