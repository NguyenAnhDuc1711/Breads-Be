// Nguồn sự thật DUY NHẤT cho công thức đếm tin nhắn chưa đọc (PRD unread-message-count).
// Không được viết lại công thức này ở nơi khác — mọi handler (sendMessage, sendNext,
// retrieveMsg, updateLastSeen, getConversations) đều phải gọi qua đây.
//
// Tách rõ 2 nhóm hàm (plan-review AD-8): nhóm GHI (recomputeUnreadCount, markConversationRead)
// dùng ở write-path (tin mới, mark-read, thu hồi); nhóm ĐỌC THUẦN (getGlobalUnreadTotal,
// getCachedUnreadCounts) dùng ở read-path (getConversations) — KHÔNG được gọi chéo, vì
// read-path là path gọi thường xuyên nhất (mỗi lần mở app) và tuyệt đối không được kèm ghi.
import ConversationRead from "../models/conversationRead.model.js";
import Message from "../models/message.model.js";
import { ObjectId } from "../../utils/index.js";

// Hàm (không phải const cố định lúc import module) để task test được NFR-4 bằng cách
// stub giá trị trả về, thay vì phụ thuộc Date.now() thật lúc chạy test.
export const getRolloutCutoverAt = (): Date =>
  new Date(process.env.UNREAD_COUNT_ROLLOUT_AT || Date.now());

const countUnread = async (conversationId: any, userId: any, lastReadAt: Date) => {
  return Message.countDocuments({
    conversationId: ObjectId(conversationId),
    createdAt: { $gt: lastReadAt },
    sender: { $ne: ObjectId(userId) },
    isRetrieve: { $ne: true },
  });
};

/**
 * GHI. Lazy-create atomic (upsert) rồi đếm lại từ nguồn sự thật, ghi cache.
 * Dùng ở: sendMessage, sendNext (tin mới), retrieveMsg (thu hồi).
 */
export const recomputeUnreadCount = async ({
  conversationId,
  userId,
}: {
  conversationId: any;
  userId: any;
}): Promise<number> => {
  const doc = await ConversationRead.findOneAndUpdate(
    { conversationId: ObjectId(conversationId), userId: ObjectId(userId) },
    { $setOnInsert: { lastReadAt: getRolloutCutoverAt() } },
    { upsert: true, new: true }
  );

  const unreadCount = await countUnread(conversationId, userId, doc.lastReadAt);

  await ConversationRead.updateOne({ _id: doc._id }, { unreadCount });

  return unreadCount;
};

/**
 * GHI. Đánh dấu đã đọc tới 1 tin nhắn cụ thể — set lastReadAt/lastReadMessageId rồi
 * recompute (kết quả phải về 0 vì không còn message nào createdAt > lastReadAt).
 * Dùng ở: updateLastSeen (mark-as-read).
 */
export const markConversationRead = async ({
  conversationId,
  userId,
  lastMsg,
}: {
  conversationId: any;
  userId: any;
  lastMsg: { _id: any; createdAt: Date };
}): Promise<number> => {
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

/**
 * ĐỌC THUẦN. Tổng unread toàn cục của 1 user, tính động qua aggregate (index userId).
 * Dùng ở: mọi payload real-time (FR-3/FR-5) và getConversations (FR-7).
 */
export const getGlobalUnreadTotal = async (userId: any): Promise<number> => {
  const result = await ConversationRead.aggregate([
    { $match: { userId: ObjectId(userId) } },
    { $group: { _id: null, total: { $sum: "$unreadCount" } } },
  ]);
  return result[0]?.total ?? 0;
};

/**
 * ĐỌC THUẦN — KHÔNG được gọi recomputeUnreadCount/markConversationRead từ đây.
 * Dùng ở: getConversations (cold-start read, path gọi thường xuyên nhất — mở app).
 * Trả về map conversationId(string) -> unreadCount, mặc định 0 cho conversation
 * chưa từng có document (chưa có sự kiện ghi nào, an toàn coi là 0 tin chưa đọc).
 */
export const getCachedUnreadCounts = async ({
  conversationIds,
  userId,
}: {
  conversationIds: any[];
  userId: any;
}): Promise<Record<string, number>> => {
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
