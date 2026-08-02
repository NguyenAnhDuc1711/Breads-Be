// One-off seed: give a fixed list of "celebrity" users a large, deliberately
// *uneven* follower base (mega star down to minor celebrity), to have real
// data for testing the fan-out celebrity problem (push-on-write doesn't
// scale to millions of followers, and not all celebrities are equally big).
//
// Strategy: single pass over the users collection; for each user and each
// celebrity, an independent Bernoulli trial (probability = target/totalUsers)
// decides whether that user follows that celebrity. Followers are only ever
// drawn from the live `users` collection cursor, so every followerId is
// guaranteed to reference a real, existing user. No duplicate
// (followerId, followeeId) pairs are possible since each pair is only ever
// considered once.
//
// Usage: node src/api/seed/seedCelebrityFollows.js
import dotenv from "dotenv";
import mongoose from "mongoose";
import Follow from "../models/follow.model.js";

dotenv.config();

// Deliberately spread across tiers (50k minor celebrity -> 2M mega star)
// instead of one flat number for everyone.
const CELEBRITY_TARGETS = {
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

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017");
  console.log("Connected to MongoDB");

  const celebrityIds = Object.keys(CELEBRITY_TARGETS);
  const celebrityObjectIds = celebrityIds.map(
    (id) => new mongoose.Types.ObjectId(id)
  );
  const celebrityIdStrings = new Set(celebrityIds);

  console.log("Clearing previously seeded follows for these celebrities...");
  const { deletedCount } = await Follow.deleteMany({
    followeeId: { $in: celebrityObjectIds },
  });
  console.log(`Removed ${deletedCount} existing follow records`);

  const totalUsers = await mongoose.connection.db
    .collection("users")
    .countDocuments();
  const probabilities = {};
  for (const id of celebrityIds) {
    probabilities[id] = CELEBRITY_TARGETS[id] / totalUsers;
  }
  console.log(`Total users in pool: ${totalUsers}`);
  console.log("Target follower counts:", CELEBRITY_TARGETS);

  const cursor = mongoose.connection.db
    .collection("users")
    .find({}, { projection: { _id: 1 } });

  let batch = [];
  let processed = 0;
  let created = 0;
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

  for await (const user of cursor) {
    processed++;
    const userIdStr = user._id.toString();
    if (!celebrityIdStrings.has(userIdStr)) {
      for (const id of celebrityIds) {
        if (Math.random() < probabilities[id]) {
          batch.push({
            followerId: user._id,
            followeeId: new mongoose.Types.ObjectId(id),
          });
        }
      }
    }
    if (batch.length >= BATCH_SIZE) {
      await flush();
    }
    if (processed % 200000 === 0) {
      process.stdout.write(
        `\rProcessed ${processed} users, created ${created} follow records`
      );
    }
  }
  await flush();

  const seconds = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `\nDone. Processed ${processed} users, created ${created} follow records in ${seconds}s`
  );

  const counts = await Follow.aggregate([
    { $match: { followeeId: { $in: celebrityObjectIds } } },
    { $group: { _id: "$followeeId", followers: { $sum: 1 } } },
  ]);
  console.log("Follower counts per celebrity (target -> actual):");
  for (const id of celebrityIds) {
    const found = counts.find((c) => c._id.toString() === id);
    console.log(
      `  ${id}: target=${CELEBRITY_TARGETS[id]} actual=${found?.followers ?? 0}`
    );
  }

  console.log("Verifying every followerId references a real user...");
  const verify = await Follow.aggregate([
    { $match: { followeeId: { $in: celebrityObjectIds } } },
    {
      $lookup: {
        from: "users",
        localField: "followerId",
        foreignField: "_id",
        as: "followerDoc",
      },
    },
    { $match: { followerDoc: { $size: 0 } } },
    { $count: "danglingFollowerRefs" },
  ]);
  console.log(
    `Dangling followerId references (should be 0): ${verify[0]?.danglingFollowerRefs ?? 0}`
  );

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error("Seeding failed:", err);
  process.exit(1);
});
