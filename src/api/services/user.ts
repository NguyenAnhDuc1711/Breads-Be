import { ObjectId } from "../../utils/index.js";
import { stripEmptyOptionalFields } from "../../utils/emptyFieldFilter.ts";
import logger from "../../core/logger.js";
import Follow from "../models/follow.model.js";
import SavedPost from "../models/savedPost.model.js";
import User from "../models/user.model.js";
import {
  backfillFeedOnFollow,
  removeFeedOnUnfollow,
} from "./feed/fanout.ts";
import { USER_CONFIG } from "./userConfig.ts";

// Field required — KHÔNG bao giờ bị lược dù giá trị rỗng (mở rộng lean-api-response sang User,
// tương ứng REQUIRED_POST_FIELDS ở post.ts). `email`/`role` giữ nguyên vì mọi consumer hiện tại
// đều cần (câu hỏi "email có nên ẩn với người xem khác" là vấn đề PHÂN QUYỀN khác, ngoài scope
// lean-api-response, không xử lý ở đây).
export const REQUIRED_USER_FIELDS: ReadonlySet<string> = new Set([
  "_id",
  "name",
  "username",
  "avatar",
  "bio",
  "email",
  "role",
]);

// Without a cap, `$lookup` buffers every matching `follows` doc in memory
// before continuing the pipeline. Celebrity accounts (see
// seedCelebrityFollows.ts, up to 2M followers) blow past MongoDB's 100MB
// per-lookup buffer limit, crashing `getUserInfo` on login. Local membership
// checks ("am I following X") never need more than a bounded slice, so the
// `pipeline` limits each lookup regardless of how large the account is.
const FOLLOW_RELATIONS_LIMIT = 5000;

// Stages that compute `followed` (follower ids) and `following` (followee ids)
// from the Follow collection, matching the shape of the old embedded arrays.
export const followRelationsLookupStages = (localField = "_id") => [
  {
    $lookup: {
      from: "follows",
      localField,
      foreignField: "followeeId",
      pipeline: [
        { $limit: FOLLOW_RELATIONS_LIMIT },
        { $project: { _id: 0, followerId: 1 } },
      ],
      as: "followedByDocs",
    },
  },
  {
    $lookup: {
      from: "follows",
      localField,
      foreignField: "followerId",
      pipeline: [
        { $limit: FOLLOW_RELATIONS_LIMIT },
        { $project: { _id: 0, followeeId: 1 } },
      ],
      as: "followingDocs",
    },
  },
  {
    $addFields: {
      followed: "$followedByDocs.followerId",
      following: "$followingDocs.followeeId",
    },
  },
];

// `includeRelations` pulls the full followed/following id arrays (needed so
// the requester's own profile can do local "am I following X" membership
// checks). Viewing someone else's profile only ever needs the counts, which
// are plain fields — skip the follows lookup there, since a celebrity
// followee can have millions of followers and returning that whole array
// just to read `.length` is the exact join-then-scan cost we removed
// elsewhere (see getForYouPostsId / getUsersToFollow).
export const getUserInfo = async (userId, { includeRelations = true } = {}) => {
  try {
    if (!userId) {
      return null;
    }
    const result = await User.aggregate([
      { $match: { _id: ObjectId(userId) } },
      ...(includeRelations ? followRelationsLookupStages() : []),
      {
        $project: {
          password: 0,
          updatedAt: 0,
          followedByDocs: 0,
          followingDocs: 0,
        },
      },
    ]);
    const user = result?.[0];
    if (!user) {
      return null;
    }
    const savedPosts = await SavedPost.find(
      { userId: ObjectId(userId) },
      { postId: 1 }
    ).sort({ createdAt: -1 });
    user.collection = savedPosts.map(({ postId }) => postId);
    if (!USER_CONFIG.responseFieldFilterEnabled) {
      return user;
    }
    return stripEmptyOptionalFields(user, REQUIRED_USER_FIELDS);
  } catch (err) {
    logger.error({ err }, "getUserInfo failed");
  }
};

export const toggleFollow = async (followerId, followeeId) => {
  const existing = await Follow.findOne({
    followerId: ObjectId(followerId),
    followeeId: ObjectId(followeeId),
  });
  if (existing) {
    await Follow.deleteOne({ _id: existing._id });
    await User.updateOne(
      { _id: ObjectId(followerId) },
      { $inc: { followingCount: -1 } }
    );
    await User.updateOne(
      { _id: ObjectId(followeeId) },
      { $inc: { followersCount: -1 } }
    );
    // Fire-and-forget, giống fanoutPostToFollowers (NFR-2) — request unfollow không chờ Redis/Mongo.
    removeFeedOnUnfollow(followerId, followeeId).catch((err) =>
      logger.error({ err }, "[toggleFollow] removeFeedOnUnfollow failed")
    );
    return false;
  }
  await Follow.create({
    followerId: ObjectId(followerId),
    followeeId: ObjectId(followeeId),
  });
  await User.updateOne(
    { _id: ObjectId(followerId) },
    { $inc: { followingCount: 1 } }
  );
  await User.updateOne(
    { _id: ObjectId(followeeId) },
    { $inc: { followersCount: 1 } }
  );
  // Fire-and-forget, giống fanoutPostToFollowers (NFR-2) — request follow không chờ Redis/Mongo.
  backfillFeedOnFollow(followerId, followeeId).catch((err) =>
    logger.error({ err }, "[toggleFollow] backfillFeedOnFollow failed")
  );
  return true;
};

export const getUsersByPage = async ({ page, limit, agg }) => {
  try {
    const skip = Number((page - 1) * limit);
    const data = await User.aggregate([
      ...agg,
      {
        $project: {
          _id: 1,
          avatar: 1,
          username: 1,
          name: 1,
          bio: 1,
          followed: 1,
          status: 1,
        },
      },
      { $skip: skip },
      {
        $limit: Number(limit),
      },
    ]);
    return data;
  } catch (err) {
    logger.error({ err }, "getUsersByPage failed");
    return [];
  }
};
