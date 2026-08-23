// Verification script (not a one-off migration itself): counts posts that match the sitemap
// filter shape (`status=PUBLIC, visibility=PUBLIC` — see FR-3) but are still missing the
// `engagementScore` field on production. `backfillEngagementScore.ts` was written to backfill
// this field, but its run against production was never confirmed — if any such post still lacks
// the field, Mongo's `$gte` range filter silently excludes it (a missing field never matches a
// range operator), so the sitemap/discovery endpoints would drop URLs with no visible error.
// Safe to run repeatedly: only re-runs the backfill when the count is > 0.
import dotenv from "dotenv";
import mongoose from "mongoose";
import { pathToFileURL } from "url";
import Post from "../models/post.model.js";
import { backfillEngagementScore } from "./backfillEngagementScore.js";
import { Constants } from "../../Breads-Shared/Constants/index.js";

dotenv.config();

export const verifyEngagementScoreBackfillProd = async () => {
  const totalChecked = await Post.countDocuments({
    status: Constants.POST_STATUS.PUBLIC,
    visibility: Constants.POST_VISIBILITY.PUBLIC,
  });

  const missingCount = await Post.countDocuments({
    status: Constants.POST_STATUS.PUBLIC,
    visibility: Constants.POST_VISIBILITY.PUBLIC,
    engagementScore: { $exists: false },
  });

  let backfilledCount = 0;
  if (missingCount > 0) {
    await backfillEngagementScore();
    backfilledCount = missingCount;
  }

  console.log(
    `verified: ${totalChecked} posts checked, ${missingCount} missing engagementScore, backfilled ${backfilledCount}`,
  );

  return { totalChecked, missingCount, backfilledCount };
};

const main = async () => {
  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017");
  try {
    await verifyEngagementScoreBackfillProd();
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
    console.error("Verification failed:", err);
    process.exit(1);
  });
}
