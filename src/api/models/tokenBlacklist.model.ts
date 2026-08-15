import mongoose from "mongoose";

const tokenBlacklistSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true,
  },
  reason: {
    type: String,
    enum: ["TOKEN_REUSE", "FORCED_LOGOUT", "SUSPICIOUS_ACTIVITY"],
    required: true,
  },
  detectedAt: {
    type: Date,
    default: Date.now,
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
});

const TokenBlacklist = mongoose.model("TokenBlacklist", tokenBlacklistSchema);

export default TokenBlacklist;
