import mongoose from "mongoose";

const ObjectId = mongoose.Schema.Types.ObjectId;

// Candidate con — không cần `_id` riêng, chỉ tồn tại lồng trong `candidates` (task 001/FR-1/FR-2).
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

// Unique — mỗi user chỉ có đúng 1 doc suggestion (cron/worker upsert theo userId, task 010).
followSuggestionSchema.index({ userId: 1 }, { unique: true });

const FollowSuggestion = mongoose.model("FollowSuggestion", followSuggestionSchema);

export default FollowSuggestion;
