import "dotenv/config.js";
import mongoose from "mongoose";
import crypto from "crypto";
import Post from "../models/post.model.js";
import User from "../models/user.model.js";
import { seedPosts } from "./generatePosts.js";
import { seedUsers } from "./generateUsers.js";
import { ObjectIdPool } from "./idPool.js";

const parseArgs = () => {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    args[key] = value ?? "true";
  }
  return args;
};

const printProgress = (label) => (done, total) => {
  const pct = ((done / total) * 100).toFixed(1);
  process.stdout.write(`\r${label}: ${done}/${total} (${pct}%)`);
  if (done === total) process.stdout.write("\n");
};

const run = async () => {
  const args = parseArgs();

  if (args.users === undefined || args.posts === undefined) {
    console.log(
      "Usage: npx tsx src/api/seed/index.ts --users=<N> --posts=<N> [--batchSize=2000] [--authorPool=300000] [--reset]",
    );
    process.exit(1);
  }

  const userCount = Number(args.users);
  const postCount = Number(args.posts);
  const batchSize = Number(args.batchSize ?? 2000);
  const authorPoolCapacity = Number(args.authorPool ?? 300000);
  const mediaRate = Number(args.mediaRate ?? 0.4);
  const reset = args.reset === "true";

  if (!Number.isFinite(userCount) || !Number.isFinite(postCount)) {
    throw new Error("--users and --posts must be numbers");
  }
  if (!Number.isFinite(mediaRate) || mediaRate < 0 || mediaRate > 1) {
    throw new Error("--mediaRate must be a number between 0 and 1");
  }

  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017");
  console.log("Connected to MongoDB");

  if (reset) {
    console.log(
      "Removing previously seeded fake data (username matching /^fake_/)...",
    );
    const fakeUsers = await User.find(
      { username: /^fake_/ },
      { _id: 1 },
    ).lean();
    const fakeUserIds = fakeUsers.map((u) => u._id);
    const { deletedCount: postsDeleted } = await Post.deleteMany({
      authorId: { $in: fakeUserIds },
    });
    const { deletedCount: usersDeleted } = await User.deleteMany({
      username: /^fake_/,
    });
    console.log(
      `Removed ${usersDeleted} fake users and ${postsDeleted} of their posts`,
    );
  }

  const runId = crypto.randomBytes(4).toString("hex");
  const start = Date.now();

  let authorPool;
  if (userCount > 0) {
    console.log(
      `Seeding ${userCount} users (run=${runId}, batch=${batchSize})...`,
    );
    authorPool = await seedUsers({
      runId,
      count: userCount,
      batchSize,
      authorPoolCapacity,
      onProgress: printProgress("Users"),
    });
  } else {
    console.log("--users=0: sampling existing fake_ users as post authors...");
    authorPool = new ObjectIdPool(authorPoolCapacity);
    const existing = await User.find({ username: /^fake_/ }, { _id: 1 })
      .limit(authorPoolCapacity)
      .lean();
    existing.forEach((u) => authorPool.push(u._id));
  }

  if (postCount > 0) {
    if (authorPool.size === 0) {
      throw new Error(
        "No author pool available for posts — seed users first (drop --users=0), or ensure fake_ users already exist.",
      );
    }
    console.log(
      `Seeding ${postCount} posts (batch=${batchSize}, mediaRate=${mediaRate})...`,
    );
    await seedPosts({
      count: postCount,
      authorPool,
      batchSize,
      mediaRate,
      onProgress: printProgress("Posts"),
    });
  }

  const seconds = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`Done in ${seconds}s`);
  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error("Seeding failed:", err);
  process.exit(1);
});
