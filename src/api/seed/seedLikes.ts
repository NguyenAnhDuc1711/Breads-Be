// One-off seed: give posts a realistic like distribution — most posts get a
// handful of likes (or none), while posts authored by a seeded celebrity
// (see seedCelebrityFollows.ts) get a much higher, follower-scaled count, so
// ranking/engagement code has real high-vs-low engagement data to sort on.
//
// Strategy: single pass over the `posts` collection. For each post, pick a
// mean like count — `--celebrityEngagementRate` × that celebrity's target
// follower count (capped by `--celebrityAvgLikesCap`) for celebrity authors,
// or a flat `--ordinaryAvgLikes` for everyone else — then sample an actual
// count from an exponential distribution around that mean (so it varies post
// to post instead of every post from the same author landing on an identical
// number) and like it with that many random users from a sampling pool.
//
// This only inserts Like documents. Run these next to sync denormalized
// fields from them:
//   npm run migrate:backfill-like-follow-counts   (Post.likesCount)
//   npm run migrate:backfill-engagement-score     (Post.engagementScore)
//
// Usage: npx tsx src/api/seed/seedLikes.ts [--ordinaryAvgLikes=3] [--celebrityEngagementRate=0.002] [--celebrityAvgLikesCap=3000] [--likerPoolCapacity=500000]
import dotenv from "dotenv";
import mongoose from "mongoose";
import Like from "../models/like.model.js";
import { ObjectIdPool } from "./idPool.js";

dotenv.config();

// Keep in sync with CELEBRITY_TARGETS in seedCelebrityFollows.ts — used here
// to scale a celebrity's average likes-per-post with how big they are (a
// mega star's posts should out-perform a minor celebrity's, not tie with it).
const CELEBRITY_FOLLOWERS = {
  "66fa65b4775c617545634c99": 2000000,
  "671ee34db863a9a7301732af": 50000,
  "66e66070f27cd4c9a4287fa6": 1200000,
  "66e66070f27cd4c9a42880d8": 300000,
  "66e66070f27cd4c9a42880dc": 800000,
  "66e66070f27cd4c9a428812a": 100000,
  "66e66070f27cd4c9a4288044": 1500000,
  "66e66070f27cd4c9a42880da": 600000,
  "66e66070f27cd4c9a4288062": 200000,
  "66e66070f27cd4c9a4288052": 400000,
};

const BATCH_SIZE = 5000;

const parseArgs = () => {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    args[key] = value ?? "true";
  }
  return args;
};

// Inverse-CDF sample from an exponential distribution with the given mean.
// Unlike follow-degree sampling, 0 is a valid (and common) outcome here —
// most ordinary posts get no likes at all.
const sampleCount = (mean) => {
  if (mean <= 0) return 0;
  return Math.floor(-mean * Math.log(1 - Math.random()));
};

const run = async () => {
  const args = parseArgs();
  const ordinaryAvgLikes = Number(args.ordinaryAvgLikes ?? 3);
  const celebrityEngagementRate = Number(args.celebrityEngagementRate ?? 0.002);
  const celebrityAvgLikesCap = Number(args.celebrityAvgLikesCap ?? 3000);
  const likerPoolCapacity = Number(args.likerPoolCapacity ?? 500000);

  if (!Number.isFinite(ordinaryAvgLikes) || ordinaryAvgLikes < 0) {
    throw new Error("--ordinaryAvgLikes must be a non-negative number");
  }
  if (!Number.isFinite(celebrityEngagementRate) || celebrityEngagementRate < 0) {
    throw new Error("--celebrityEngagementRate must be a non-negative number");
  }
  if (!Number.isFinite(celebrityAvgLikesCap) || celebrityAvgLikesCap < 0) {
    throw new Error("--celebrityAvgLikesCap must be a non-negative number");
  }

  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017");
  console.log("Connected to MongoDB");

  console.log("Building liker sampling pool...");
  const pool = new ObjectIdPool(likerPoolCapacity);
  {
    const cursor = mongoose.connection.db
      .collection("users")
      .find({}, { projection: { _id: 1 } });
    for await (const user of cursor) {
      pool.push(user._id);
    }
  }
  console.log(`Liker pool: ${pool.size} users (capped at ${likerPoolCapacity})`);
  if (pool.size === 0) {
    throw new Error("No users available to like posts");
  }

  console.log(
    `Generating likes (ordinaryAvgLikes=${ordinaryAvgLikes}, ` +
      `celebrityEngagementRate=${celebrityEngagementRate}, celebrityAvgLikesCap=${celebrityAvgLikesCap})...`
  );

  let batch = [];
  let processed = 0;
  let attempted = 0;
  let created = 0;
  const start = Date.now();

  const flush = async () => {
    if (batch.length === 0) return;
    const toInsert = batch;
    batch = [];
    try {
      const res = await Like.insertMany(toInsert, { ordered: false });
      created += res.length;
    } catch (err) {
      created += err?.insertedDocs?.length ?? 0;
    }
  };

  const cursor = mongoose.connection.db
    .collection("posts")
    .find({}, { projection: { _id: 1, authorId: 1 } });

  for await (const post of cursor) {
    if (!post.authorId) continue;
    processed++;

    const celebFollowers = CELEBRITY_FOLLOWERS[String(post.authorId)];
    const mean = celebFollowers
      ? Math.min(celebFollowers * celebrityEngagementRate, celebrityAvgLikesCap)
      : ordinaryAvgLikes;
    const likeCount = sampleCount(mean);

    for (let i = 0; i < likeCount; i++) {
      const liker = pool.sample();
      if (liker.equals(post.authorId)) continue;
      batch.push({ postId: post._id, userId: liker });
      attempted++;
    }

    if (batch.length >= BATCH_SIZE) {
      await flush();
    }
    if (processed % 200000 === 0) {
      process.stdout.write(
        `\rProcessed ${processed} posts, attempted ${attempted} likes, created ${created}`
      );
    }
  }
  await flush();

  const seconds = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `\nDone. Processed ${processed} posts, attempted ${attempted} likes, created ${created} new records in ${seconds}s`
  );
  console.log(
    "Run `npm run migrate:backfill-like-follow-counts` then `npm run migrate:backfill-engagement-score` next."
  );

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error("Seeding failed:", err);
  process.exit(1);
});
