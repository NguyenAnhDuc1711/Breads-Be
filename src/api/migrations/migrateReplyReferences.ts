import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

const migrateReplyReferences = async () => {
  const db = mongoose.connection.db;
  const posts = await db
    .collection("posts")
    .find(
      { replies: { $exists: true, $ne: [] } },
      { projection: { _id: 1, replies: 1 } },
    )
    .toArray();

  const childOps = [];
  const parentOps = [];
  for (const post of posts) {
    for (const replyId of post.replies ?? []) {
      childOps.push({
        updateOne: {
          filter: { _id: replyId },
          update: { $set: { parentPost: post._id } },
        },
      });
    }
    parentOps.push({
      updateOne: {
        filter: { _id: post._id },
        update: { $set: { repliesCount: post.replies?.length ?? 0 } },
      },
    });
  }

  for (let i = 0; i < childOps.length; i += 1000) {
    await db.collection("posts").bulkWrite(childOps.slice(i, i + 1000));
  }
  console.log(`Backfilled parentPost for ${childOps.length} replies`);

  for (let i = 0; i < parentOps.length; i += 1000) {
    await db.collection("posts").bulkWrite(parentOps.slice(i, i + 1000));
  }
  console.log(`Backfilled repliesCount for ${parentOps.length} posts`);

  await db.collection("posts").updateMany({}, { $unset: { replies: "" } });
  console.log("Dropped legacy replies field from posts");
};

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017");
  await migrateReplyReferences();
  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
