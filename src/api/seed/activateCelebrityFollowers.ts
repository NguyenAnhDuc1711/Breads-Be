// One-off maintenance script: bump `lastActiveAt` to "now" for every
// follower of a given followee, so fanout.ts's getActiveFollowerIds() (which
// filters followers by `lastActiveAt >= now - activeWindowDays days`, see
// src/api/services/feed/fanout.ts) doesn't silently drop most of them.
//
// Without this, followers seeded by seedCelebrityFollows.ts /
// seedOrdinaryFollows.ts have no lastActiveAt at all (field is unset by
// default, see user.model.ts), so the active-follower query would filter
// nearly everyone out — making a fan-out load test look like it does almost
// no work even though the raw follower count is high.
//
// Usage: npx tsx src/api/seed/activateCelebrityFollowers.ts [--followeeId=671ee34db863a9a7301732af]
import dotenv from "dotenv";
import mongoose from "mongoose";
import Follow from "../models/follow.model.js";
import User from "../models/user.model.js";

dotenv.config();

const BATCH_SIZE = 5000;

const parseArgs = () => {
  const args: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    args[key] = value ?? "true";
  }
  return args;
};

const run = async () => {
  const args = parseArgs();
  const followeeId = args.followeeId ?? "671ee34db863a9a7301732af";

  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017");
  console.log("Connected to MongoDB");

  const followeeObjectId = new mongoose.Types.ObjectId(followeeId);
  const followerIds = (
    await Follow.find({ followeeId: followeeObjectId }, { followerId: 1 }).lean()
  ).map((f: any) => f.followerId);

  console.log(`Followee ${followeeId} has ${followerIds.length} followers to activate`);
  if (followerIds.length === 0) {
    console.log("Nothing to do — did you run seed:celebrity-follows first?");
    await mongoose.disconnect();
    process.exit(0);
  }

  const now = new Date();
  let updated = 0;
  const start = Date.now();

  for (let i = 0; i < followerIds.length; i += BATCH_SIZE) {
    const batch = followerIds.slice(i, i + BATCH_SIZE);
    const res = await User.updateMany(
      { _id: { $in: batch } },
      { $set: { lastActiveAt: now } }
    );
    updated += res.modifiedCount ?? 0;
    process.stdout.write(`\rActivated ${Math.min(i + BATCH_SIZE, followerIds.length)}/${followerIds.length}`);
  }

  const seconds = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nDone. Set lastActiveAt=now on ${updated} followers in ${seconds}s`);

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error("Activation failed:", err);
  process.exit(1);
});
