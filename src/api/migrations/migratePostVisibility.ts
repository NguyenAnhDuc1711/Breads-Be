// One-off migration: backfill Post.visibility for existing documents.
//
// MongoDB does not apply Mongoose schema defaults when matching existing
// documents at the query layer -- `default` only fires when hydrating a
// document into memory, not during Post.find/updateMany matching. Every
// Post document that existed before `visibility` was added to the schema
// (task 001) has no `visibility` field at all, so a direct-match query like
// `Post.find({ visibility: 0 })` would silently exclude every one of them.
// Task 010 (enforce visibility on every read path) depends on this having
// run first, since it uses direct-match queries with no `$exists:false`
// fallback.
//
// Two branches, order matters (branch 1 must run before branch 2, so branch
// 2's `visibility: { $exists: false }` condition no longer matches the
// documents branch 1 already set `visibility` on -- no overlap, no
// double-write):
//   1. Documents whose `status` still holds a legacy combined value (2 =
//      old ONLY_ME, 3 = old ONLY_FOLLOWERS, from before task 001 split
//      POST_STATUS/POST_VISIBILITY into two separate enums) -> map to the
//      new `visibility` field and reset `status` to PUBLIC.
//   2. Any remaining document missing `visibility` entirely (including ones
//      that never had a legacy status=2/3) -> default it to PUBLIC.
//
// Idempotent: after the first run no document matches either branch's
// filter, so running this again performs zero updates.
//
// Before running: confirm MONGO_URI (logged below) points at the intended
// database. This project has no real production environment yet, but the
// check is logged regardless as a safety habit for when one exists.
import dotenv from "dotenv";
import mongoose from "mongoose";
import Post from "../models/post.model.js";
import { Constants } from "../../Breads-Shared/Constants/index.js";

dotenv.config();

// Legacy POST_STATUS values from before task 001's enum split. These keys
// no longer exist on Constants.POST_STATUS -- kept here as raw numbers,
// this comment is the only remaining record of what they used to mean.
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

  // Branch 1a: legacy status=2 (ONLY_ME) -> visibility=ONLY_ME, status=PUBLIC
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

  // Branch 1b: legacy status=3 (ONLY_FOLLOWERS) -> visibility=ONLY_FOLLOWERS, status=PUBLIC
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

  // Branch 2: everything still missing `visibility` -> default to PUBLIC.
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
