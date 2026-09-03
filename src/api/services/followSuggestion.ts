import mongoose from "mongoose";
import { ObjectId } from "../../utils/index.js";
import User from "../models/user.model.js";
import { FEED_CONFIG } from "./feed/config.ts";
import { FOLLOW_SUGGESTION_CONFIG } from "./followSuggestion/config.ts";

export type SuggestionCandidate = {
  userId: mongoose.Types.ObjectId;
  score: number;
  mutualFriendCount: number;
  categoryOverlapCount: number;
};

export const computeSuggestionsForUser = async (
  userId: string | mongoose.Types.ObjectId,
): Promise<SuggestionCandidate[]> => {
  const userObjectId = ObjectId(userId);

  const celebrities = await User.find(
    { followersCount: { $gt: FEED_CONFIG.celebrityThreshold } },
    { _id: 1 },
  ).lean();
  const celebrityIds = celebrities.map((c: any) => c._id);

  const rawCandidates = await User.aggregate([
    { $match: { _id: userObjectId } },
    { $project: { _id: 1 } },
    {
      $graphLookup: {
        from: "follows",
        startWith: "$_id",
        connectFromField: "followeeId",
        connectToField: "followerId",
        maxDepth: 1,
        depthField: "depth",
        as: "network",
        restrictSearchWithMatch: { followerId: { $nin: celebrityIds } },
      },
    },
    { $unwind: "$network" },
    {
      $match: {
        "network.depth": 1,
        "network.followeeId": { $ne: userObjectId },
      },
    },
    {
      $group: {
        _id: "$network.followeeId",
        mutualFriendCount: { $sum: 1 },
      },
    },
  ]);

  if (rawCandidates.length === 0) return [];

  const requester = await User.findById(userObjectId, { catesCare: 1 }).lean();
  const requesterCates = new Set(
    ((requester as any)?.catesCare ?? []).map((c: any) => String(c)),
  );

  const candidateIds = rawCandidates.map((c: any) => c._id);
  const candidateUsers = await User.find(
    { _id: { $in: candidateIds } },
    { catesCare: 1 },
  ).lean();
  const catesByUser = new Map(
    candidateUsers.map((u: any) => [String(u._id), u.catesCare ?? []]),
  );

  const scored: SuggestionCandidate[] = rawCandidates.map((c: any) => {
    const cates = catesByUser.get(String(c._id)) ?? [];
    const categoryOverlapCount = cates.filter((cat: any) =>
      requesterCates.has(String(cat)),
    ).length;
    const score =
      FOLLOW_SUGGESTION_CONFIG.mutualFriendWeight * c.mutualFriendCount +
      FOLLOW_SUGGESTION_CONFIG.categoryOverlapWeight * categoryOverlapCount;
    return {
      userId: c._id,
      score,
      mutualFriendCount: c.mutualFriendCount,
      categoryOverlapCount,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, FOLLOW_SUGGESTION_CONFIG.topN);
};
