import dotenv from "dotenv";
import mongoose from "mongoose";
import Follow from "../models/follow.model.js";
import Like from "../models/like.model.js";

dotenv.config();

const migrateFollows = async () => {
  const db = mongoose.connection.db;
  const users = await db
    .collection("users")
    .find({ following: { $exists: true } }, { projection: { _id: 1, following: 1 } })
    .toArray();

  const ops = [];
  for (const user of users) {
    for (const followeeId of user.following ?? []) {
      ops.push({
        updateOne: {
          filter: { followerId: user._id, followeeId },
          update: {
            $setOnInsert: {
              followerId: user._id,
              followeeId,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
          upsert: true,
        },
      });
    }
  }
  if (ops.length) {
    await Follow.bulkWrite(ops);
  }
  console.log(`Migrated ${ops.length} follow relationships`);

  await db
    .collection("users")
    .updateMany({}, { $unset: { following: "", followed: "" } });
  console.log("Dropped legacy following/followed fields from users");
};

const migrateLikes = async () => {
  const db = mongoose.connection.db;
  const posts = await db
    .collection("posts")
    .find({ usersLike: { $exists: true } }, { projection: { _id: 1, usersLike: 1 } })
    .toArray();

  const ops = [];
  for (const post of posts) {
    for (const userId of post.usersLike ?? []) {
      ops.push({
        updateOne: {
          filter: { postId: post._id, userId },
          update: {
            $setOnInsert: {
              postId: post._id,
              userId,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
          upsert: true,
        },
      });
    }
  }
  if (ops.length) {
    await Like.bulkWrite(ops);
  }
  console.log(`Migrated ${ops.length} likes`);

  await db.collection("posts").updateMany({}, { $unset: { usersLike: "" } });
  console.log("Dropped legacy usersLike field from posts");
};

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017");
  await migrateFollows();
  await migrateLikes();
  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
