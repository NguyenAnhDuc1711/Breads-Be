import { POST_PATH, Route } from "../../../Breads-Shared/APIConfig.js";
import PostConstants from "../../../Breads-Shared/Constants/PostConstants.js";
import { getRedisInstance } from "../../../dbs/redis.ts";
import { getAllSockets } from "../../../socket/services/user.ts";
import { ObjectId } from "../../../utils/index.js";
import Follow from "../../models/follow.model.js";
import Post from "../../models/post.model.js";
import User from "../../models/user.model.js";
import { buildVisibilityQuery } from "../post.js";
import { FEED_CONFIG } from "./config.ts";
import { zAddPostForUsers, zReplaceUserFeed } from "./zset.ts";

const DAY_MS = 86400_000;

/** Sentinel "vừa thử rebuild xong" — 022 đọc key này để không rebuild lại vô ích (FAIL-2). */
export const rebuiltSentinelKey = (userId: string): string =>
  `feed:rebuilt:${userId}`;

const SENTINEL_TTL_SECONDS = 60;

const activeCutoff = (): Date =>
  new Date(Date.now() - FEED_CONFIG.activeWindowDays * DAY_MS);

/**
 * `SET feed:rebuilt:{userId} 1 EX 60`, không bao giờ throw.
 *
 * Không dùng `setCache` của `src/dbs/redis.ts`: hàm đó `throw` khi instance chưa init, và caller
 * ở đây nằm trong đường fire-and-forget / đường đọc feed — nơi Redis chết phải là no-op, không
 * phải 5xx (NFR-3). Cùng hợp đồng với các helper trong `zset.ts`.
 */
const setRebuiltSentinel = async (userId: string): Promise<void> => {
  const r = getRedisInstance();
  if (!r) {
    console.warn("[feed-rebuild] sentinel: redis chưa init (instance=null) — no-op");
    return;
  }
  try {
    await r.set(rebuiltSentinelKey(userId), "1", "EX", SENTINEL_TTL_SECONDS);
  } catch (err) {
    console.error("[feed-rebuild] sentinel failed:", err);
  }
};

/**
 * Follower của `authorId` có `lastActiveAt` trong `activeWindowDays` ngày gần nhất.
 *
 * Lọc nằm **trong truy vấn** (`$lookup` + sub-pipeline `$match`, chạy trên index
 * `{ lastActiveAt: -1 }` của 002/PERF-1), không lọc ở Node và **không** thay bằng flag `XX` của
 * `ZADD`: `XX` là ràng buộc mức member (chỉ update member đã tồn tại) nên sẽ chặn luôn việc thêm
 * post mới vào mọi ZSET — fan-out sẽ không ghi được gì (FR-5).
 *
 * Bỏ bộ lọc này cũng làm mọi `ZADD` **hồi sinh** ZSET của user đã hết TTL → trần bộ nhớ R-3/NFR-5
 * rò rỉ; TTL chỉ có tác dụng khi key thật sự ngừng được ghi.
 */
export const getActiveFollowerIds = async (
  authorId: any,
): Promise<string[]> => {
  const cutoff = activeCutoff();
  const rows = await Follow.aggregate([
    { $match: { followeeId: ObjectId(String(authorId)) } },
    {
      $lookup: {
        from: "users",
        localField: "followerId",
        foreignField: "_id",
        as: "u",
        pipeline: [
          { $match: { lastActiveAt: { $gte: cutoff } } },
          { $project: { _id: 1 } },
        ],
      },
    },
    { $match: { "u.0": { $exists: true } } },
    { $project: { _id: 0, followerId: 1 } },
  ]);
  return rows.map((r) => String(r.followerId));
};

/**
 * Fan-out-on-write: đẩy `post._id` vào ZSET của từng follower đang active (FR-5).
 *
 * **Phải được gọi không `await`** từ `createPost` (NFR-2) — xem call-site trong
 * `post.controller.ts`. Hàm tự nuốt lỗi Redis (qua `zAddPostForUsers`), nhưng lỗi Mongo vẫn
 * reject nên call-site bắt buộc có `.catch()`.
 */
export const fanoutPostToFollowers = async (params: {
  post: any;
  /** Socket.IO server instance (`req.app.get("socket_io")`), dùng cho real-time push 030/T9 khi
   * `FEED_CONFIG.socketEnabled === true`; bỏ qua toàn bộ nhánh socket nếu không truyền. */
  io?: any;
}): Promise<void> => {
  const { post } = params;
  if (!FEED_CONFIG.fanoutEnabled) return;

  const { CREATE, EDIT, REPOST } = PostConstants.ACTIONS;
  if (![CREATE, EDIT, REPOST].includes(post?.type)) return; // reply không lên feed

  const t0 = Date.now();
  const postId = String(post._id);

  // `followersCount` đã denormalize sẵn (A-2) — tuyệt đối không `countDocuments` trong write path.
  const author: any = await User.findOne(
    { _id: post.authorId },
    { followersCount: 1 },
  ).lean();

  // FR-6: tác giả trên ngưỡng sinh ĐÚNG 0 ZSET write; 022 merge họ vào feed lúc đọc.
  if ((author?.followersCount ?? 0) > FEED_CONFIG.celebrityThreshold) {
    console.log("[feed-fanout]", {
      postId,
      celebrity: true,
      followers: author?.followersCount ?? 0,
      zadds: 0,
      durationMs: Date.now() - t0,
    });
    return;
  }

  const followerIds = await getActiveFollowerIds(post.authorId);
  // Score = `createdAt` epoch ms (AD-2), KHÔNG phải điểm đã decay. Batch 2000 + trim + EXPIRE
  // đều nằm trong helper của 001 — không dựng pipeline ở đây.
  await zAddPostForUsers(followerIds, postId, new Date(post.createdAt).getTime());

  // [030/T9] Real-time push cho follower đang online (FR-10). Mặc định TẮT (REDUCE-2) — xem
  // `FEED_CONFIG.socketEnabled`. Registry chỉ được quét ĐÚNG MỘT LẦN cho cả lượt fan-out (build
  // `Map<userId, socketId>` rồi tra cứu) — KHÔNG lặp per-follower việc quét toàn registry, việc đó
  // biến 1 post thành N lượt quét (vi phạm NFR-2).
  if (FEED_CONFIG.socketEnabled && params.io && followerIds.length) {
    try {
      const sockets = await getAllSockets(params.io); // đúng một lần cho cả lượt fan-out
      const byUser = new Map<string, string>();
      for (const sk of sockets ?? []) {
        const d: any = sk?.data ?? sk;
        if (d?.userId) byUser.set(String(d.userId), String(d.id ?? sk.id));
      }
      let emitted = 0;
      const event = Route.POST + POST_PATH.NEW_FROM_FOLLOWEE;
      for (const uid of followerIds) {
        const socketId = byUser.get(String(uid));
        if (socketId) {
          params.io
            .to(socketId)
            .emit(event, { postId, authorId: String(post.authorId) });
          emitted++;
        }
      }
      console.log("[feed-socket]", {
        postId,
        online: emitted,
        followers: followerIds.length,
        socketScans: 1,
      });
    } catch (err) {
      // Lỗi socket không được làm hỏng fan-out ZSET đã ghi xong ở trên (không throw/reject ở đây).
      console.error("[feed-socket] error", err);
    }
  }

  // [plan-review TEST-3] Fan-out là fire-and-forget nên không có điểm hoàn thành quan sát được từ
  // bên ngoài; dòng log này là cách duy nhất kiểm chứng SC-6 mà không phải đua với `redis-cli
  // MONITOR`. Bắt buộc giữ lại, không phải log debug tạm.
  console.log("[feed-fanout]", {
    postId,
    celebrity: false,
    followers: followerIds.length,
    zadds: followerIds.length,
    durationMs: Date.now() - t0,
  });
};

/**
 * Dựng lại ZSET feed của `userId` từ Mongo; trả về **số entry đã ghi** (FAIL-2).
 *
 * Trả số chứ không phải `void` vì `ZADD` với 0 member **không tạo key**: nếu rebuild của một viewer
 * luôn ra 0 entry (user mới, hoặc chỉ follow celebrity) thì `EXISTS feed:zset:{u}` vĩnh viễn `false`
 * và lazy rebuild của 022/FR-9 sẽ chạy lại rebuild ở **mọi** request tiếp theo của chính viewer đó —
 * một stampede tự gây ra, không có lỗi nào báo hiệu. Khi trả 0, hàm ghi sentinel
 * `feed:rebuilt:{userId}` (TTL 60s) để 022 biết "vừa thử rồi, đừng thử lại".
 */
export const rebuildUserFeedZset = async (userId: any): Promise<number> => {
  const uid = String(userId);

  // Followee "thường" — loại celebrity (022 merge họ vào lúc đọc). `$not: { $gt: ... }` khớp cả
  // doc thiếu `followersCount`, đồng nhất với `?? 0` ở nhánh celebrity phía trên.
  const followeeRows = await Follow.aggregate([
    { $match: { followerId: ObjectId(uid) } },
    {
      $lookup: {
        from: "users",
        localField: "followeeId",
        foreignField: "_id",
        as: "u",
        pipeline: [
          {
            $match: {
              followersCount: { $not: { $gt: FEED_CONFIG.celebrityThreshold } },
            },
          },
          { $project: { _id: 1 } },
        ],
      },
    },
    { $match: { "u.0": { $exists: true } } },
    { $project: { _id: 0, followeeId: 1 } },
  ]);

  const { CREATE, EDIT, REPOST } = PostConstants.ACTIONS;
  // AD-2: ZSET của viewer chỉ được chứa bài viewer thật sự xem được. `followeeRows` chính là
  // tập author của truy vấn này nên tái dùng luôn làm `followeeIds` cho nhánh ONLY_FOLLOWERS —
  // tương đương về kết quả và tiết kiệm 1 truy vấn `Follow`.
  const visibilityQuery = await buildVisibilityQuery(
    uid,
    followeeRows.map((r) => r.followeeId),
  );
  const posts: any[] = followeeRows.length
    ? await Post.find(
        {
          authorId: { $in: followeeRows.map((r) => r.followeeId) },
          type: { $in: [CREATE, EDIT, REPOST] },
          createdAt: { $gte: activeCutoff() },
          ...visibilityQuery,
        },
        { _id: 1, createdAt: 1 },
      )
        .sort({ createdAt: -1 })
        .limit(FEED_CONFIG.zsetMaxSize)
        .lean()
    : [];

  const entries = posts.map((p) => ({
    postId: String(p._id),
    scoreMs: new Date(p.createdAt).getTime(),
  }));

  // `zReplaceUserFeed` tự DEL + ZADD + trim + EXPIRE (001) — không gọi EXPIRE ở đây.
  await zReplaceUserFeed(uid, entries);
  if (entries.length === 0) await setRebuiltSentinel(uid);

  console.log("[feed-rebuild]", {
    userId: uid,
    entries: entries.length,
    sentinel: entries.length === 0,
  });
  return entries.length;
};
