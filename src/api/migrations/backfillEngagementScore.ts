// One-off migration: compute Post.engagementScore for existing posts from
// likesCount/repliesCount/media/survey so ranking reads a real value instead of the
// schema default. Uses $set (not $inc), so it is safe to run multiple times.
// Run AFTER `migrate:reply-references` on a fresh DB — `repliesCount` only exists once that
// migration has backfilled it from the legacy `replies` array.
import dotenv from "dotenv";
import mongoose from "mongoose";
import Post from "../models/post.model.js";

dotenv.config();

const backfillEngagementScore = async () => {
  const scores = await Post.aggregate([
    {
      $project: {
        engagementScore: {
          $add: [
            { $multiply: [{ $ifNull: ["$likesCount", 0] }, 3] },
            { $multiply: [{ $ifNull: ["$repliesCount", 0] }, 3] },
            { $multiply: [{ $size: { $ifNull: ["$media", []] } }, 2] },
            { $size: { $ifNull: ["$survey", []] } },
          ],
        },
      },
    },
  ]);

  const ops = scores.map(({ _id, engagementScore }) => ({
    updateOne: {
      filter: { _id },
      update: { $set: { engagementScore } },
    },
  }));

  for (let i = 0; i < ops.length; i += 1000) {
    await Post.bulkWrite(ops.slice(i, i + 1000));
  }

  await Post.updateMany(
    { engagementScore: { $exists: false } },
    { $set: { engagementScore: 0 } },
  );

  console.log(`Backfilled engagementScore for ${ops.length} posts`);
};

const main = async () => {
  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017");
  try {
    await backfillEngagementScore();
  } finally {
    await mongoose.disconnect();
  }
  process.exit(0);
};

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
