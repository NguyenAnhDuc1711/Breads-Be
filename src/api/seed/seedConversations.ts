// One-off seed: realistic conversations + messages so messaging features
// (list, search, "jump to message" via Conversation.msgIds) have data to
// run against instead of the current near-empty collections (36
// conversations / 436 messages as of this writing).
//
// Strategy: two phases.
//   1. Insert `--conversations` Conversation docs — participants sampled
//      from a random user pool, mostly 1:1 DMs with a `--groupRatio` slice
//      of small group chats (3..maxGroupSize people).
//   2. For each conversation, sample a message count from an exponential
//      distribution (mean = --avgMsgsPerConversation, long tail like real
//      chat activity — a handful of very active threads, most modest).
//      Messages get client-side `_id`s (so we know them without a
//      round-trip) and timestamps sorted within the conversation's
//      lifetime. `Conversation.msgIds`/`lastMsgId` are filled in afterwards
//      — those fields are actually read by production code
//      (`socket/controllers/message.controller.ts` jump-to-message
//      pagination), so leaving them empty would make the seed data silently
//      wrong for that feature, not just "less realistic".
//
// Usage: npx tsx src/api/seed/seedConversations.ts [--conversations=20000] [--avgMsgsPerConversation=40] [--groupRatio=0.15] [--maxGroupSize=6] [--mediaRate=0.1] [--batchSize=5000] [--participantPoolCapacity=300000]
import dotenv from "dotenv";
import mongoose from "mongoose";
import { faker } from "@faker-js/faker";
import { Constants } from "../../Breads-Shared/Constants/index.js";
import Conversation from "../models/conversation.model.js";
import Message from "../models/message.model.js";
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

// Same inverse-CDF exponential sampler as seedOrdinaryFollows.ts's
// sampleDegree — most conversations get a modest number of messages, a long
// tail gets a lot more. Floor of 1 so every conversation has at least one
// message (an empty conversation with no lastMsgId would be unrealistic).
const sampleMessageCount = (mean) =>
  Math.max(1, Math.round(-mean * Math.log(1 - Math.random())));

const randomMedia = () => [
  {
    url: `https://picsum.photos/seed/${faker.string.alphanumeric(12)}/600/400`,
    type: Constants.MEDIA_TYPE.IMAGE,
  },
];

// Distinct participant ids for one conversation. Small `size` (2-6) against
// a large pool makes collisions rare; a Set + retry loop is simpler than a
// dedicated sampling-without-replacement structure and cheap at this scale.
const samplePartners = (pool, size) => {
  const ids = new Set();
  let guard = size * 20;
  while (ids.size < size && guard-- > 0) {
    ids.add(pool.sample().toString());
  }
  return Array.from(ids).map((id) => new mongoose.Types.ObjectId(id));
};

const run = async () => {
  const args = parseArgs();
  const conversationCount = Number(args.conversations ?? 20000);
  const avgMsgsPerConversation = Number(args.avgMsgsPerConversation ?? 40);
  const groupRatio = Number(args.groupRatio ?? 0.15);
  const maxGroupSize = Number(args.maxGroupSize ?? 6);
  const mediaRate = Number(args.mediaRate ?? 0.1);
  const batchSize = Number(args.batchSize ?? 5000);
  const participantPoolCapacity = Number(args.participantPoolCapacity ?? 300000);

  if (!Number.isFinite(conversationCount) || conversationCount <= 0) {
    throw new Error("--conversations must be a positive number");
  }
  if (!Number.isFinite(avgMsgsPerConversation) || avgMsgsPerConversation <= 0) {
    throw new Error("--avgMsgsPerConversation must be a positive number");
  }

  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017");
  console.log("Connected to MongoDB");

  console.log("Building participant sampling pool...");
  const pool = new ObjectIdPool(participantPoolCapacity);
  {
    const cursor = mongoose.connection.db
      .collection("users")
      .find({}, { projection: { _id: 1 } });
    for await (const user of cursor) {
      pool.push(user._id);
    }
  }
  console.log(`Participant pool: ${pool.size} users`);
  if (pool.size < 2) {
    throw new Error("Need at least 2 users to seed conversations");
  }

  // Phase 1: conversations. Kept in memory afterwards (id + participants +
  // createdAt only, a few hundred bytes each) to drive phase 2 — safe at
  // tens of thousands of conversations.
  console.log(`Creating ${conversationCount} conversations...`);
  const conversations = [];
  {
    let batch = [];
    const flush = async () => {
      if (batch.length === 0) return;
      const toInsert = batch;
      batch = [];
      let docs;
      try {
        docs = await Conversation.insertMany(toInsert, { ordered: false });
      } catch (err) {
        docs = err?.insertedDocs ?? [];
      }
      for (const doc of docs) {
        conversations.push({
          _id: doc._id,
          participants: doc.participants,
          createdAt: doc.createdAt,
        });
      }
    };

    for (let i = 0; i < conversationCount; i++) {
      const isGroup = Math.random() < groupRatio;
      const size = isGroup ? Math.floor(Math.random() * (maxGroupSize - 2)) + 3 : 2;
      batch.push({
        participants: samplePartners(pool, size),
        createdAt: faker.date.past({ years: 1 }),
      });
      if (batch.length >= batchSize) await flush();
      if ((i + 1) % 50000 === 0) {
        process.stdout.write(`\rConversations created: ${i + 1}/${conversationCount}`);
      }
    }
    await flush();
  }
  console.log(`\nConversations created: ${conversations.length}`);

  // Phase 2: messages, streamed conversation by conversation so memory stays
  // bounded regardless of --conversations.
  console.log(`Generating messages (avg ${avgMsgsPerConversation}/conversation)...`);
  let messageBatch = [];
  let conversationUpdates = [];
  let totalMessages = 0;
  let processedConversations = 0;

  const flushMessages = async () => {
    if (messageBatch.length === 0) return;
    const toInsert = messageBatch;
    messageBatch = [];
    try {
      await Message.insertMany(toInsert, { ordered: false });
    } catch (err) {
      console.log(
        `\nseedConversations: ${err?.writeErrors?.length ?? "some"} messages failed in this batch`,
      );
    }
  };

  const flushConversationUpdates = async () => {
    if (conversationUpdates.length === 0) return;
    const ops = conversationUpdates;
    conversationUpdates = [];
    await Conversation.bulkWrite(
      ops.map(({ _id, msgIds, lastMsgId }) => ({
        updateOne: { filter: { _id }, update: { $set: { msgIds, lastMsgId } } },
      })),
      { ordered: false },
    );
  };

  for (const conversation of conversations) {
    const count = sampleMessageCount(avgMsgsPerConversation);
    const windowStart = conversation.createdAt.getTime();
    const windowEnd = Date.now();

    // Timestamps sampled uniformly across the conversation's lifetime, then
    // sorted, so `createdAt` order matches send order like a real chat.
    const timestamps = Array.from(
      { length: count },
      () => windowStart + Math.random() * Math.max(windowEnd - windowStart, 1),
    ).sort((a, b) => a - b);

    const msgIds = [];
    for (const ts of timestamps) {
      const _id = new mongoose.Types.ObjectId();
      const sender =
        conversation.participants[Math.floor(Math.random() * conversation.participants.length)];
      const hasMedia = Math.random() < mediaRate;
      const seenByOthers = Math.random() < 0.7;

      messageBatch.push({
        _id,
        conversationId: conversation._id,
        sender,
        content: faker.lorem.sentence({ min: 2, max: 25 }),
        media: hasMedia ? randomMedia() : [],
        type: Constants.MSG_TYPE.TEXT,
        usersSeen: seenByOthers
          ? conversation.participants.filter((p) => !p.equals(sender))
          : [],
        createdAt: new Date(ts),
      });
      msgIds.push(_id);
    }

    if (msgIds.length) {
      conversationUpdates.push({
        _id: conversation._id,
        msgIds,
        lastMsgId: msgIds[msgIds.length - 1],
      });
      totalMessages += msgIds.length;
    }

    if (messageBatch.length >= batchSize) await flushMessages();
    if (conversationUpdates.length >= batchSize) await flushConversationUpdates();

    processedConversations++;
    if (processedConversations % 2000 === 0) {
      process.stdout.write(
        `\rConversations processed: ${processedConversations}/${conversations.length}, messages: ${totalMessages}`,
      );
    }
  }
  await flushMessages();
  await flushConversationUpdates();

  console.log(`\nDone. ${conversations.length} conversations, ${totalMessages} messages.`);

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error("Seeding failed:", err);
  process.exit(1);
});
