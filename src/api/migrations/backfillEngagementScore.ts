import dotenv from "dotenv";
import mongoose from "mongoose";
import { pathToFileURL } from "url";
import Post from "../models/post.model.js";

dotenv.config();

export const backfillEngagementScore = async () => {
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

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
