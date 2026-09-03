import { ObjectId } from "../../utils/index.js";
import logger from "../../core/logger.js";
import Follow from "../models/follow.model.js";
import SavedPost from "../models/savedPost.model.js";
import User from "../models/user.model.js";
import {
  backfillFeedOnFollow,
  removeFeedOnUnfollow,
} from "./feed/fanout.ts";

const FOLLOW_RELATIONS_LIMIT = 5000;

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
    return user;
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
          role: 1,
          createdAt: 1,
          lastActiveAt: 1,
          email: 1,
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
