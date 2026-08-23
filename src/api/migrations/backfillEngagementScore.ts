// One-off migration: compute Post.engagementScore for existing posts from
// likesCount/repliesCount/media/survey so ranking reads a real value instead of the
// schema default. Uses $set (not $inc), so it is safe to run multiple times.
// Run AFTER `migrate:reply-references` on a fresh DB — `repliesCount` only exists once that
// migration has backfilled it from the legacy `replies` array.
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

// Chỉ tự chạy main() khi file này được gọi trực tiếp (`npm run migrate:backfill-engagement-score`),
// không chạy khi bị import làm module (vd. `verifyEngagementScoreBackfillProd.ts` tái sử dụng hàm
// `backfillEngagementScore` ở trên mà không cần tự connect/disconnect/exit trùng lặp).
const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
