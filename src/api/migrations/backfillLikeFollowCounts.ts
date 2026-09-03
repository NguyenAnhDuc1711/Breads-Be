import dotenv from "dotenv";
import mongoose from "mongoose";
import Follow from "../models/follow.model.js";
import Like from "../models/like.model.js";
import Post from "../models/post.model.js";
import User from "../models/user.model.js";

dotenv.config();

const backfillLikesCount = async () => {
  const counts = await Like.aggregate([
    { $group: { _id: "$postId", count: { $sum: 1 } } },
  ]);
  const ops = counts.map(({ _id, count }) => ({
    updateOne: {
      filter: { _id },
      update: { $set: { likesCount: count } },
    },
  }));
  if (ops.length) {
    await Post.bulkWrite(ops);
  }
  await Post.updateMany(
    { likesCount: { $exists: false } },
    { $set: { likesCount: 0 } },
  );
  console.log(`Backfilled likesCount for ${ops.length} posts`);
};

const backfillFollowCounts = async () => {
  const [followerCounts, followingCounts] = await Promise.all([
    Follow.aggregate([
      { $group: { _id: "$followeeId", count: { $sum: 1 } } },
    ]),
    Follow.aggregate([
      { $group: { _id: "$followerId", count: { $sum: 1 } } },
    ]),
  ]);

  const followerOps = followerCounts.map(({ _id, count }) => ({
    updateOne: {
      filter: { _id },
      update: { $set: { followersCount: count } },
    },
  }));
  const followingOps = followingCounts.map(({ _id, count }) => ({
    updateOne: {
      filter: { _id },
      update: { $set: { followingCount: count } },
    },
  }));

  if (followerOps.length) {
    await User.bulkWrite(followerOps);
  }
  if (followingOps.length) {
    await User.bulkWrite(followingOps);
  }
  await User.updateMany(
    { followersCount: { $exists: false } },
    { $set: { followersCount: 0 } },
  );
  await User.updateMany(
    { followingCount: { $exists: false } },
    { $set: { followingCount: 0 } },
  );
  console.log(
    `Backfilled followersCount for ${followerOps.length} users, followingCount for ${followingOps.length} users`,
  );
};

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017");
  await backfillLikesCount();
  await backfillFollowCounts();
  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
