// One-off seed: give the `notifications` collection realistic volume so
// `getNotifications` (paginated `{toUsers: userId}` query, sorted by
// createdAt) has real data to page through — currently 3 documents total.
//
// Strategy: two independent streaming passes, each mirroring how the real
// app creates notifications (see `socket/controllers/post.controller.ts`
// `likePost` and `socket/controllers/notification.controller.ts` `create`):
//   1. Stream the `posts` collection. Each post gets a small chance
//      (exponential mean = --postNotifyRate) of generating 1+ notifications
//      with action LIKE/REPLY/REPOST/TAG, `target` = that post, `toUsers` =
//      [post author] — modeling "someone reacted to your post".
//   2. Stream the `follows` collection — already real follower/followee
//      pairs — and sample a `--followNotifyRate` fraction into FOLLOW
//      notifications. Reusing real edges keeps `fromUser` genuinely
//      following `toUsers[0]`, matching how a FOLLOW notification is only
//      ever created alongside a real Follow document in production.
//
// Defaults produce roughly postNotifyRate*posts + followNotifyRate*follows
// notifications — with the current dataset (~6M posts, ~74M follows) that's
// ~300k + ~74k ≈ 370k documents, plenty to exercise pagination/index
// behavior without an expensive multi-collection join.
//
// Usage: npx tsx src/api/seed/seedNotifications.ts [--postNotifyRate=0.05] [--followNotifyRate=0.001] [--actorPoolCapacity=300000] [--batchSize=5000]
import dotenv from "dotenv";
import mongoose from "mongoose";
import { faker } from "@faker-js/faker";
import { Constants } from "../../Breads-Shared/Constants/index.js";
import Notification from "../models/notification.model.js";
import { ObjectIdPool } from "./idPool.js";

dotenv.config();

const parseArgs = () => {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    args[key] = value ?? "true";
  }
  return args;
};

// Same exponential sampler as seedLikes.ts's sampleCount — 0 is the common
// outcome, occasionally a post gets more than one reaction-notification.
const sampleCount = (mean) => {
  if (mean <= 0) return 0;
  return Math.floor(-mean * Math.log(1 - Math.random()));
};

// LIKE dominates in a real feed, REPLY/REPOST/TAG progressively rarer.
const POST_ACTIONS = [
  { action: Constants.NOTIFICATION_ACTION.LIKE, weight: 55 },
  { action: Constants.NOTIFICATION_ACTION.REPLY, weight: 25 },
  { action: Constants.NOTIFICATION_ACTION.REPOST, weight: 12 },
  { action: Constants.NOTIFICATION_ACTION.TAG, weight: 8 },
];
const TOTAL_WEIGHT = POST_ACTIONS.reduce((sum, a) => sum + a.weight, 0);
const randomPostAction = () => {
  let r = Math.random() * TOTAL_WEIGHT;
  for (const { action, weight } of POST_ACTIONS) {
    if (r < weight) return action;
    r -= weight;
  }
  return POST_ACTIONS[0].action;
};

const run = async () => {
  const args = parseArgs();
  const postNotifyRate = Number(args.postNotifyRate ?? 0.05);
  const followNotifyRate = Number(args.followNotifyRate ?? 0.001);
  const actorPoolCapacity = Number(args.actorPoolCapacity ?? 300000);
  const batchSize = Number(args.batchSize ?? 5000);

  if (!Number.isFinite(postNotifyRate) || postNotifyRate < 0) {
    throw new Error("--postNotifyRate must be a non-negative number");
  }
  if (!Number.isFinite(followNotifyRate) || followNotifyRate < 0) {
    throw new Error("--followNotifyRate must be a non-negative number");
  }

  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017");
  console.log("Connected to MongoDB");

  console.log("Building actor sampling pool...");
  const actorPool = new ObjectIdPool(actorPoolCapacity);
  {
    const cursor = mongoose.connection.db
      .collection("users")
      .find({}, { projection: { _id: 1 } });
    for await (const user of cursor) {
      actorPool.push(user._id);
    }
  }
  console.log(`Actor pool: ${actorPool.size} users`);
  if (actorPool.size === 0) {
    throw new Error("No users available to act as notification senders");
  }

  let batch = [];
  let created = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const toInsert = batch;
    batch = [];
    try {
      const res = await Notification.insertMany(toInsert, { ordered: false });
      created += res.length;
    } catch (err) {
      created += err?.insertedDocs?.length ?? 0;
    }
  };

  console.log(`Pass 1/2: post-based notifications (rate=${postNotifyRate})...`);
  {
    let processed = 0;
    const cursor = mongoose.connection.db
      .collection("posts")
      .find({}, { projection: { _id: 1, authorId: 1 } });
    for await (const post of cursor) {
      processed++;
      const count = sampleCount(postNotifyRate);
      for (let i = 0; i < count; i++) {
        const fromUser = actorPool.sample();
        if (!post.authorId || fromUser.equals(post.authorId)) continue;
        batch.push({
          fromUser,
          toUsers: [post.authorId],
          action: randomPostAction(),
          target: post._id,
          createdAt: faker.date.past({ years: 1 }),
        });
      }
      if (batch.length >= batchSize) await flush();
      if (processed % 500000 === 0) {
        process.stdout.write(`\rPosts processed: ${processed}, notifications created: ${created}`);
      }
    }
    await flush();
  }
  console.log(`\nPass 1 done. Created so far: ${created}`);

  console.log(`Pass 2/2: follow-based notifications (rate=${followNotifyRate})...`);
  {
    let processed = 0;
    const cursor = mongoose.connection.db
      .collection("follows")
      .find({}, { projection: { followerId: 1, followeeId: 1 } });
    for await (const follow of cursor) {
      processed++;
      if (Math.random() < followNotifyRate) {
        batch.push({
          fromUser: follow.followerId,
          toUsers: [follow.followeeId],
          action: Constants.NOTIFICATION_ACTION.FOLLOW,
          createdAt: faker.date.past({ years: 1 }),
        });
      }
      if (batch.length >= batchSize) await flush();
      if (processed % 5000000 === 0) {
        process.stdout.write(`\rFollows processed: ${processed}, notifications created: ${created}`);
      }
    }
    await flush();
  }

  console.log(`\nDone. Total notifications created: ${created}`);

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error("Seeding failed:", err);
  process.exit(1);
});
