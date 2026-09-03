import ConversationRead from "../models/conversationRead.model.js";
import Message from "../models/message.model.js";
import { ObjectId } from "../../utils/index.js";

export const getRolloutCutoverAt = (): Date =>
  process.env.UNREAD_COUNT_ROLLOUT_AT
    ? new Date(process.env.UNREAD_COUNT_ROLLOUT_AT)
    : new Date(0);

const countUnread = async (conversationId: any, userId: any, lastReadAt: Date) => {
  return Message.countDocuments({
    conversationId: ObjectId(conversationId),
    createdAt: { $gt: lastReadAt },
    sender: { $ne: ObjectId(userId) },
    isRetrieve: { $ne: true },
  });
};

export const recomputeUnreadCount = async ({
  conversationId,
  userId,
}: {
  conversationId: any;
  userId: any;
}): Promise<number> => {
  if (!conversationId || !userId) {
    throw new Error("recomputeUnreadCount: conversationId and userId are required");
  }

  const doc = await ConversationRead.findOneAndUpdate(
    { conversationId: ObjectId(conversationId), userId: ObjectId(userId) },
    { $setOnInsert: { lastReadAt: getRolloutCutoverAt() } },
    { upsert: true, new: true }
  );

  const unreadCount = await countUnread(conversationId, userId, doc.lastReadAt);

  await ConversationRead.updateOne({ _id: doc._id }, { unreadCount });

  return unreadCount;
};

export const markConversationRead = async ({
  conversationId,
  userId,
  lastMsg,
}: {
  conversationId: any;
  userId: any;
  lastMsg: { _id: any; createdAt: Date };
}): Promise<number> => {
  if (!conversationId || !userId || !lastMsg?._id || !lastMsg?.createdAt) {
    throw new Error(
      "markConversationRead: conversationId, userId, and lastMsg (_id + createdAt) are required"
    );
  }

  const doc = await ConversationRead.findOneAndUpdate(
    { conversationId: ObjectId(conversationId), userId: ObjectId(userId) },
    {
      $setOnInsert: { lastReadAt: getRolloutCutoverAt() },
    },
    { upsert: true, new: true }
  );

  await ConversationRead.updateOne(
    { _id: doc._id },
    {
      lastReadAt: lastMsg.createdAt,
      lastReadMessageId: ObjectId(lastMsg._id),
    }
  );

  const unreadCount = await countUnread(conversationId, userId, lastMsg.createdAt);
  await ConversationRead.updateOne({ _id: doc._id }, { unreadCount });

  return unreadCount;
};

export const getGlobalUnreadTotal = async (userId: any): Promise<number> => {
  if (!userId) {
    throw new Error("getGlobalUnreadTotal: userId is required");
  }

  const result = await ConversationRead.aggregate([
    { $match: { userId: ObjectId(userId) } },
    { $group: { _id: null, total: { $sum: "$unreadCount" } } },
  ]);
  return result[0]?.total ?? 0;
};

export const getCachedUnreadCounts = async ({
  conversationIds,
  userId,
}: {
  conversationIds: any[];
  userId: any;
}): Promise<Record<string, number>> => {
  if (!userId || !Array.isArray(conversationIds)) {
    throw new Error("getCachedUnreadCounts: userId and conversationIds (array) are required");
  }

  const docs = await ConversationRead.find(
    {
      userId: ObjectId(userId),
      conversationId: { $in: conversationIds.map((id) => ObjectId(id)) },
    },
    { conversationId: 1, unreadCount: 1 }
  ).lean();

  const map: Record<string, number> = {};
  for (const id of conversationIds) {
    map[String(id)] = 0;
  }
  for (const doc of docs) {
    map[String(doc.conversationId)] = doc.unreadCount ?? 0;
  }
  return map;
};
