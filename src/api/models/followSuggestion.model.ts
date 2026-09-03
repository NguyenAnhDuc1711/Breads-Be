import mongoose from "mongoose";

const ObjectId = mongoose.Schema.Types.ObjectId;

const candidateSchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, ref: "User", required: true },
    score: { type: Number, required: true },
    mutualFriendCount: { type: Number, required: true, default: 0 },
    categoryOverlapCount: { type: Number, required: true, default: 0 },
  },
  { _id: false },
);

const followSuggestionSchema = new mongoose.Schema({
  userId: { type: ObjectId, ref: "User", required: true },
  candidates: { type: [candidateSchema], default: [] },
  computedAt: { type: Date, default: Date.now },
});

followSuggestionSchema.index({ userId: 1 }, { unique: true });

const FollowSuggestion = mongoose.model("FollowSuggestion", followSuggestionSchema);

export default FollowSuggestion;
