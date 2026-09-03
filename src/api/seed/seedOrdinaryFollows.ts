import dotenv from "dotenv";
import mongoose from "mongoose";
import Follow from "../models/follow.model.js";
import { ObjectIdPool } from "./idPool.js";

dotenv.config();

const CELEBRITY_IDS = new Set([
  "66fa65b4775c617545634c99",
  "671ee34db863a9a7301732af",
  "66e66070f27cd4c9a4287fa6",
  "66e66070f27cd4c9a42880d8",
  "66e66070f27cd4c9a42880dc",
  "66e66070f27cd4c9a428812a",
  "66e66070f27cd4c9a4288044",
  "66e66070f27cd4c9a42880da",
  "66e66070f27cd4c9a4288062",
  "66e66070f27cd4c9a4288052",
]);

const BATCH_SIZE = 5000;

const parseArgs = () => {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    args[key] = value ?? "true";
  }
  return args;
};

const sampleDegree = (mean) =>
  Math.max(1, Math.round(-mean * Math.log(1 - Math.random())));

const run = async () => {
  const args = parseArgs();
  const avgFollows = Number(args.avgFollows ?? 40);
  const mutualRatio = Number(args.mutualRatio ?? 0.35);
  const poolCapacity = Number(args.poolCapacity ?? 500000);

  if (!Number.isFinite(avgFollows) || avgFollows <= 0) {
    throw new Error("--avgFollows must be a positive number");
  }
  if (!Number.isFinite(mutualRatio) || mutualRatio < 0 || mutualRatio > 1) {
    throw new Error("--mutualRatio must be a number between 0 and 1");
  }

  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017");
  console.log("Connected to MongoDB");

  console.log("Building ordinary-user sampling pool...");
  const pool = new ObjectIdPool(poolCapacity);
  let totalOrdinary = 0;
  {
    const cursor = mongoose.connection.db
      .collection("users")
      .find({}, { projection: { _id: 1 } });
    for await (const user of cursor) {
      if (CELEBRITY_IDS.has(user._id.toString())) continue;
      totalOrdinary++;
      pool.push(user._id);
    }
  }
  console.log(
    `Ordinary users: ${totalOrdinary} (pool holds ${pool.size}, capped at ${poolCapacity})`
  );
  if (pool.size < 2) {
    throw new Error("Not enough ordinary users to build a follow graph");
  }

  console.log(
    `Generating follows (avgFollows=${avgFollows}, mutualRatio=${mutualRatio})...`
  );

  let batch = [];
  let processed = 0;
  let attempted = 0;
  let created = 0;
  let mutualAttempted = 0;
  const start = Date.now();

  const flush = async () => {
    if (batch.length === 0) return;
    const toInsert = batch;
    batch = [];
    try {
      const res = await Follow.insertMany(toInsert, { ordered: false });
      created += res.length;
    } catch (err) {
      created += err?.insertedDocs?.length ?? 0;
    }
  };

  const cursor = mongoose.connection.db
    .collection("users")
    .find({}, { projection: { _id: 1 } });

  for await (const user of cursor) {
    if (CELEBRITY_IDS.has(user._id.toString())) continue;
    processed++;

    const degree = sampleDegree(avgFollows);
    for (let i = 0; i < degree; i++) {
      const target = pool.sample();
      if (target.equals(user._id)) continue;

      batch.push({ followerId: user._id, followeeId: target });
      attempted++;

      if (Math.random() < mutualRatio) {
        mutualAttempted++;
        batch.push({ followerId: target, followeeId: user._id });
        attempted++;
      }
    }

    if (batch.length >= BATCH_SIZE) {
      await flush();
    }
    if (processed % 200000 === 0) {
      process.stdout.write(
        `\rProcessed ${processed} users, attempted ${attempted} edges, created ${created}`
      );
    }
  }
  await flush();

  const seconds = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `\nDone. Processed ${processed} ordinary users, attempted ${attempted} follow edges ` +
      `(${mutualAttempted} deliberately mutual), created ${created} new records in ${seconds}s`
  );
  console.log(
    "Run `npm run migrate:backfill-like-follow-counts` next to sync followersCount/followingCount."
  );

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error("Seeding failed:", err);
  process.exit(1);
});
