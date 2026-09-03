import dotenv from "dotenv";
import mongoose from "mongoose";
import Post from "../models/post.model.js";
import { Constants } from "../../Breads-Shared/Constants/index.js";

dotenv.config();

const OLD_ONLY_ME = 2;
const OLD_ONLY_FOLLOWERS = 3;

const migratePostVisibility = async () => {
  if (process.env.NODE_ENV === "production") {
    console.warn(
      "[migrate-post-visibility] NODE_ENV=production -- confirm MONGO_URI points at the intended database before proceeding.",
    );
  }
  console.log(
    `[migrate-post-visibility] connected to ${process.env.MONGO_URI || "mongodb://localhost:27017"}`,
  );

  const onlyMeResult = await Post.updateMany(
    { status: OLD_ONLY_ME },
    {
      $set: {
        visibility: Constants.POST_VISIBILITY.ONLY_ME,
        status: Constants.POST_STATUS.PUBLIC,
      },
    },
  );
  console.log(
    `[migrate-post-visibility] legacy status=2 (ONLY_ME) -> visibility=ONLY_ME, status=PUBLIC: matched=${onlyMeResult.matchedCount} modified=${onlyMeResult.modifiedCount}`,
  );

  const onlyFollowersResult = await Post.updateMany(
    { status: OLD_ONLY_FOLLOWERS },
    {
      $set: {
        visibility: Constants.POST_VISIBILITY.ONLY_FOLLOWERS,
        status: Constants.POST_STATUS.PUBLIC,
      },
    },
  );
  console.log(
    `[migrate-post-visibility] legacy status=3 (ONLY_FOLLOWERS) -> visibility=ONLY_FOLLOWERS, status=PUBLIC: matched=${onlyFollowersResult.matchedCount} modified=${onlyFollowersResult.modifiedCount}`,
  );

  const defaultResult = await Post.updateMany(
    { visibility: { $exists: false } },
    { $set: { visibility: Constants.POST_VISIBILITY.PUBLIC } },
  );
  console.log(
    `[migrate-post-visibility] visibility missing -> visibility=PUBLIC: matched=${defaultResult.matchedCount} modified=${defaultResult.modifiedCount}`,
  );

  const remainingMissing = await Post.countDocuments({
    visibility: { $exists: false },
  });
  const remainingLegacyStatus = await Post.countDocuments({
    status: { $in: [OLD_ONLY_ME, OLD_ONLY_FOLLOWERS] },
  });
  console.log(
    `[migrate-post-visibility] post-migration check: documents still missing visibility=${remainingMissing}, documents still on legacy status 2/3=${remainingLegacyStatus}`,
  );
};

const main = async () => {
  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017");
  try {
    await migratePostVisibility();
  } finally {
    await mongoose.disconnect();
  }
  process.exit(0);
};

main().catch((err) => {
  console.error("[migrate-post-visibility] Migration failed:", err);
  process.exit(1);
});
