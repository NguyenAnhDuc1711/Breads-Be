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

/**
 * computeSuggestionsForUser — 2-hop mutual-friend traversal trên `Follow` collection (task 001,
 * FR-1/FR-2, AD-3/AD-5 trong epic.md).
 *
 * Traversal seed từ `User` (chính user A), KHÔNG seed từ một document `Follow` đã $match trước.
 * Lý do: `$graphLookup.startWith` được tính trên INPUT DOCUMENT của stage, và ta cần
 * "depth 0 = bạn trực tiếp của A" / "depth 1 = bạn-của-bạn" (đúng đặc tả 001.md). Seed từ chính A
 * (`startWith: "$_id"`) cho: depth 0 = Follow doc có `followerId = A` (bạn trực tiếp), depth 1 =
 * Follow doc có `followerId` = bạn trực tiếp đó (bạn-của-bạn) — khớp chính xác. Seed từ
 * `$followeeId` của một Follow doc đã lọc `followerId = A` sẽ lệch 1 hop (depth 0 đã là
 * bạn-của-bạn), không khớp đặc tả và làm hub-cap ở dưới sai lệch theo.
 *
 * restrictSearchWithMatch loại document có `followerId` là celebrity
 * (`followersCount > FEED_CONFIG.celebrityThreshold`) khỏi kết quả VÀ khỏi việc tiếp tục đệ quy
 * (đúng semantics thật của `$graphLookup`: match áp dụng ở MỌI bước, tài liệu không khớp bị loại
 * khỏi output lẫn khỏi việc dùng làm điểm mở rộng tiếp theo). Vì "vai trò cầu nối" của một node X
 * chỉ phát sinh khi ta tìm document có `followerId = X` (X tự follow người khác) để đi tiếp, filter
 * trên field `followerId` của DOCUMENT TÌM THẤY chặn đúng bước đó — trong khi document "A→X"
 * (followerId=A, X là followee) không bị chặn, nên X vẫn có thể xuất hiện như một candidate hợp lệ
 * qua nhánh khác (celebrity KHÔNG bị loại khỏi kết quả cuối, chỉ khỏi vai trò cầu nối — AD-3).
 *
 * KHÔNG loại các candidate mà A đã follow trực tiếp — việc đó thuộc read-path (task 011, epic
 * Technical Approach #6), computeSuggestionsForUser chỉ sinh tín hiệu graph thô.
 */
export const computeSuggestionsForUser = async (
  userId: string | mongoose.Types.ObjectId,
): Promise<SuggestionCandidate[]> => {
  const userObjectId = ObjectId(userId);

  // Denormalize trước khi traverse (thay vì $lookup User bên trong $graphLookup — restrictSearchWithMatch
  // chỉ match field trên chính collection đang search, không hỗ trợ $lookup). Query này dùng index
  // `{status:1, followersCount:-1, _id:-1}` sẵn có trên User (`user.model.ts`).
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
