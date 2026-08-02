import { ObjectId } from "../../utils/index.js";
import Follow from "../models/follow.model.js";
import SavedPost from "../models/savedPost.model.js";
import User from "../models/user.model.js";

// Stages that compute `followed` (follower ids) and `following` (followee ids)
// from the Follow collection, matching the shape of the old embedded arrays.
export const followRelationsLookupStages = (localField = "_id") => [
  {
    $lookup: {
      from: "follows",
      localField,
      foreignField: "followeeId",
      as: "followedByDocs",
    },
  },
  {
    $lookup: {
      from: "follows",
      localField,
      foreignField: "followerId",
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
    return user;
  } catch (err) {
    console.log(err);
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
    console.log("getUsersByPage: ", err);
    return [];
  }
};
