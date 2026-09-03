import dotenv from "dotenv";
import mongoose from "mongoose";
import SavedPost from "../models/savedPost.model.js";

dotenv.config();

const migrateSavedPosts = async () => {
  const db = mongoose.connection.db;
  const collections = await db.collection("collections").find({}).toArray();

  const ops = [];
  for (const doc of collections) {
    const postsId = doc.postsId ?? [];
    const anchor = doc.updatedAt ? new Date(doc.updatedAt) : new Date();
    postsId.forEach((postId, index) => {
      const offsetMs = (postsId.length - 1 - index) * 1000;
      const createdAt = new Date(anchor.getTime() - offsetMs);
      ops.push({
        updateOne: {
          filter: { userId: doc.userId, postId },
          update: {
            $setOnInsert: {
              userId: doc.userId,
              postId,
              createdAt,
              updatedAt: createdAt,
            },
          },
          upsert: true,
        },
      });
    });
  }
  if (ops.length) {
    await SavedPost.bulkWrite(ops);
  }
  console.log(`Migrated ${ops.length} saved posts from ${collections.length} users`);

  await db.collection("collections").drop().catch(() => {});
  console.log("Dropped legacy collections collection");
};

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017");
  await migrateSavedPosts();
  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
