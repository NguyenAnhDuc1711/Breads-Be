import { POST_PATH, Route } from "../../../Breads-Shared/APIConfig.js";
import { Constants } from "../../../Breads-Shared/Constants/index.js";
import PostConstants from "../../../Breads-Shared/Constants/PostConstants.js";
import { getRedisInstance } from "../../../dbs/redis.ts";
import { getAllSockets } from "../../../socket/services/user.ts";
import { ObjectId } from "../../../utils/index.js";
import Follow from "../../models/follow.model.js";
import Post from "../../models/post.model.js";
import User from "../../models/user.model.js";
import { buildVisibilityQuery } from "../post.js";
import { FEED_CONFIG } from "./config.ts";
import {
  BATCH_SIZE,
  chunk,
  zAddPostForUsers,
  zAddPostForUsersOrThrow,
  zAddPostsForUser,
  zExists,
  zRemovePostsForUser,
  zReplaceUserFeed,
} from "./zset.ts";

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

  // FR-8: bài ONLY_ME không ai khác xem được nên fan-out sinh ĐÚNG 0 ZSET write — return sớm
  // TRƯỚC truy vấn `User.findOne` bên dưới để không tốn thêm 1 query vô ích.
  if (post?.visibility === Constants.POST_VISIBILITY.ONLY_ME) {
    const durationMs = Date.now() - t0;
    console.log("[feed-fanout]", { postId, onlyMe: true, zadds: 0, durationMs });
    return;
  }

  // `followersCount` đã denormalize sẵn (A-2) — tuyệt đối không `countDocuments` trong write path.
  const author: any = await User.findOne(
    { _id: post.authorId },
    { followersCount: 1 },
  ).lean();

  // FR-6: tác giả trên ngưỡng sinh ĐÚNG 0 ZSET write; 022 merge họ vào feed lúc đọc.
  if ((author?.followersCount ?? 0) > FEED_CONFIG.celebrityThreshold) {
    const followers = author?.followersCount ?? 0;
    const durationMs = Date.now() - t0;
    console.log("[feed-fanout]", { postId, celebrity: true, followers, zadds: 0, durationMs });
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
  const durationMs = Date.now() - t0;
  console.log("[feed-fanout]", {
    postId,
    celebrity: false,
    followers: followerIds.length,
    zadds: followerIds.length,
    durationMs,
  });
};

/** TTL cờ chống emit socket trùng khi dispatch job retry (FR-5) — 1 giờ, dư sức phủ 3 attempt. */
const SOCKET_SENT_TTL_SECONDS = 3600;

export const socketSentKey = (postId: string): string =>
  `feed:fanout:socket-sent:${postId}`;

/** Payload job `fanout-post` (dispatch tier) — task 012 enqueue đúng shape này. */
export type DispatchJobData = { postId: string; authorId?: string };

/**
 * Điểm nối I/O, chỉ để test tiêm mock — production **không truyền gì**, mọi field dùng default.
 *
 * Repo không có harness Mongo/Redis cho integration test (xem header `fanout.test.ts`), mà AC của
 * task này (chunk math 4500 follower, idempotency socket) bắt buộc phải quan sát được. Tiêm qua
 * tham số là cách rẻ nhất — không cần `--experimental-test-module-mocks` (đòi đổi npm script dùng
 * chung) và không đổi hành vi đường chạy thật.
 */
export type DispatchDeps = {
  loadPost?: (postId: string) => Promise<any>;
  loadAuthor?: (authorId: any) => Promise<any>;
  getFollowerIds?: (authorId: any) => Promise<string[]>;
  enqueueBatches?: (jobs: any[]) => Promise<unknown>;
  redis?: any;
};

/**
 * `batchQueue.addBulk` nạp **động** chứ không `import` tĩnh: `queue.ts` mở một connection ioredis
 * ngay lúc module load, nên một `import` tĩnh ở đây sẽ kéo socket đó vào MỌI process test import
 * `fanout.ts` (kể cả `fanout.test.ts` cũ, vốn không có teardown) và treo `node --test`.
 * `queue.ts` import ngược `processDispatchJob` theo đường tĩnh — chiều lười này cắt vòng lặp.
 */
const defaultEnqueueBatches = async (jobs: any[]): Promise<unknown> => {
  const { batchQueue } = await import("./queue.ts");
  return batchQueue.addBulk(jobs);
};

/**
 * Handler job `fanout-post` — tầng dispatch của kiến trúc 2 tầng (AD-1).
 *
 * Giữ **nguyên thứ tự check** của `fanoutPostToFollowers` (`type` → `ONLY_ME` → celebrity →
 * follower query), chỉ thay bước ghi ZSET trực tiếp bằng `batchQueue.addBulk()` N job
 * `fanout-batch` (1 job / `BATCH_SIZE` follower) — throttle thật nằm ở batch worker (task 011),
 * không phải ở đây: giới hạn mức job/author không chạm được burst bên trong MỘT author lớn.
 *
 * Khác `fanoutPostToFollowers` đúng một điểm bắt buộc: payload job chỉ có `postId` (JSON qua
 * Redis), nên phải nạp lại `post` từ Mongo trước khi vào chuỗi check.
 *
 * `fanoutPostToFollowers` gốc **không đụng tới** — vẫn là đường `FEED_FANOUT_MODE=direct` (FR-8).
 */
export const processDispatchJob = async (
  data: DispatchJobData,
  io?: any,
  deps: DispatchDeps = {},
): Promise<void> => {
  const t0 = Date.now();
  const postId = String(data.postId);

  const loadPost =
    deps.loadPost ?? ((id: string) => Post.findOne({ _id: id }).lean());
  const loadAuthor =
    deps.loadAuthor ??
    ((authorId: any) =>
      User.findOne({ _id: authorId }, { followersCount: 1 }).lean());
  const getFollowerIds = deps.getFollowerIds ?? getActiveFollowerIds;
  const enqueueBatches = deps.enqueueBatches ?? defaultEnqueueBatches;

  const post: any = await loadPost(postId);
  // Post bị xoá giữa lúc job nằm chờ trong queue — không có gì để fan-out, và KHÔNG throw (throw
  // ở đây chỉ tạo 3 attempt vô ích cho một tình huống không bao giờ tự khỏi).
  if (!post) {
    console.log("[feed-fanout]", { postId, missing: true, batches: 0, durationMs: Date.now() - t0 });
    return;
  }

  const { CREATE, EDIT, REPOST } = PostConstants.ACTIONS;
  if (![CREATE, EDIT, REPOST].includes(post?.type)) return; // reply không lên feed

  // FR-8: bài ONLY_ME không ai khác xem được nên fan-out sinh ĐÚNG 0 ZSET write — return sớm
  // TRƯỚC truy vấn `User.findOne` bên dưới để không tốn thêm 1 query vô ích.
  if (post?.visibility === Constants.POST_VISIBILITY.ONLY_ME) {
    const durationMs = Date.now() - t0;
    console.log("[feed-fanout]", { postId, onlyMe: true, zadds: 0, batches: 0, durationMs });
    return;
  }

  // `followersCount` đã denormalize sẵn (A-2) — tuyệt đối không `countDocuments` trong write path.
  const author: any = await loadAuthor(post.authorId);

  // FR-6: tác giả trên ngưỡng sinh ĐÚNG 0 ZSET write; 022 merge họ vào feed lúc đọc.
  if ((author?.followersCount ?? 0) > FEED_CONFIG.celebrityThreshold) {
    const followers = author?.followersCount ?? 0;
    const durationMs = Date.now() - t0;
    console.log("[feed-fanout]", { postId, celebrity: true, followers, zadds: 0, batches: 0, durationMs });
    return;
  }

  const followerIds = await getFollowerIds(post.authorId);
  // Score = `createdAt` epoch ms (AD-2), KHÔNG phải điểm đã decay.
  const scoreMs = new Date(post.createdAt).getTime();
  // Chia đúng theo `BATCH_SIZE` của `zset.ts` (không định nghĩa lại) — mỗi batch job xuống tới
  // `zAddPostForUsers` sẽ chạy đúng 1 `pipeline.exec()`, không chunk chồng chunk.
  const chunks = chunk(followerIds, BATCH_SIZE);
  if (chunks.length) {
    await enqueueBatches(
      chunks.map((c, i) => ({
        name: "fanout-batch",
        data: { postId, followerIds: c, scoreMs },
        opts: {
          // Dedup: dispatch job retry sẽ addBulk lại đúng bộ jobId này, BullMQ bỏ qua job đã tồn
          // tại thay vì tạo bản sao (FR-3/scenario 5).
          jobId: `${postId}:batch:${i}`,
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: { count: 5000 },
          removeOnFail: { count: 5000 },
        },
      })),
    );
  }

  // [030/T9] Real-time push cho follower đang online (FR-10). Mặc định TẮT (REDUCE-2) — xem
  // `FEED_CONFIG.socketEnabled`. Registry chỉ được quét ĐÚNG MỘT LẦN cho cả lượt dispatch (AD-4:
  // socket KHÔNG tách theo batch, nếu không sẽ thành N lượt quét/post — vi phạm NFR-2 cũ).
  const sentKey = socketSentKey(postId);
  const r = deps.redis ?? getRedisInstance();
  const alreadySent = r ? await r.exists(sentKey) : 0;
  if (FEED_CONFIG.socketEnabled && io && followerIds.length && !alreadySent) {
    try {
      const sockets = await getAllSockets(io); // đúng một lần cho cả lượt fan-out
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
          io.to(socketId).emit(event, { postId, authorId: String(post.authorId) });
          emitted++;
        }
      }
      // FR-5: đặt cờ SAU khi emit xong — nếu attempt này chết giữa chừng, attempt sau vẫn được
      // phép emit lại (thà trùng còn hơn mất, và cửa sổ trùng chỉ nằm trong 1 job).
      if (r) await r.set(sentKey, "1", "EX", SOCKET_SENT_TTL_SECONDS);
      console.log("[feed-socket]", {
        postId,
        online: emitted,
        followers: followerIds.length,
        socketScans: 1,
      });
    } catch (err) {
      // Lỗi socket không được làm hỏng các batch job đã enqueue xong ở trên (không throw ở đây).
      console.error("[feed-socket] error", err);
    }
  }

  const durationMs = Date.now() - t0;
  console.log("[feed-fanout]", {
    postId,
    celebrity: false,
    followers: followerIds.length,
    batches: chunks.length,
    durationMs,
  });
};

/** Payload job `fanout-batch` (batch tier) — task 010 enqueue đúng shape này (`addBulk`). */
export type BatchJobData = {
  postId: string;
  followerIds: string[];
  scoreMs: number;
};

/**
 * Handler job `fanout-batch` — tầng batch của kiến trúc 2 tầng (AD-1), rate-limited toàn hệ thống
 * qua `limiter` của `Worker` (task 011, `queue.ts`).
 *
 * Gọi `zAddPostForUsersOrThrow` (AD-3), KHÔNG phải `zAddPostForUsers` gốc: hàm gốc nuốt lỗi
 * pipeline (chỉ `console.error`), nên nếu dùng ở đây BullMQ sẽ luôn thấy job `completed` kể cả khi
 * ghi Redis thất bại thật — retry (FR-6) sẽ chết ngay từ thiết kế. `followerIds` đã ≤ `BATCH_SIZE`
 * do dispatch worker chia sẵn, nên không chunk lại ở đây.
 */
export const processBatchJob = async ({
  postId,
  followerIds,
  scoreMs,
}: BatchJobData): Promise<void> => {
  await zAddPostForUsersOrThrow(followerIds, postId, scoreMs);
  // [021] Dòng log tối thiểu để đo SC-10 (khoảng cách batch đầu/cuối) từ log app thật, vì fan-out
  // là fire-and-forget nên k6 http_req_duration không phản ánh chi phí này (xem header
  // fanout-celebrity-stress.js).
  console.log("[feed-fanout-batch]", { postId, completedAt: Date.now() });
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

/**
 * Backfill bài cũ của followee mới vào ZSET của follower ngay khi follow — không có bước này,
 * follower phải đợi followee đăng bài MỚI thì fan-out-on-write mới đẩy bài vào ZSET (fan-out chỉ
 * đẩy tương lai, không hồi cứu quá khứ).
 *
 * Guard `zExists` bắt buộc: nếu ZSET của follower **chưa từng tồn tại**, ZADD ở đây sẽ tạo key
 * chỉ với bài của MỘT followee — `zExists` sau đó trả `true`, khoá luôn nhánh lazy-rebuild-đầy-đủ
 * (`feed/index.ts`) khỏi bao giờ chạy cho follower này, feed kẹt vĩnh viễn ở "chỉ có bài của
 * followee vừa follow" tới khi TTL hết hạn. Bỏ qua khi ZSET chưa tồn tại — lazy rebuild sẽ tự bao
 * gồm followee mới vì nó query theo Follow graph hiện tại.
 *
 * Cùng cửa sổ `activeCutoff()` với `rebuildUserFeedZset` để nội dung backfill nhất quán với nội
 * dung một lần rebuild đầy đủ sẽ cho ra.
 */
export const backfillFeedOnFollow = async (
  followerId: any,
  followeeId: any,
): Promise<void> => {
  if (!FEED_CONFIG.fanoutEnabled) return;

  const followerUid = String(followerId);
  if (!(await zExists(followerUid))) return;

  const followee: any = await User.findOne(
    { _id: followeeId },
    { followersCount: 1 },
  ).lean();
  // Celebrity: 0 ZSET write, giống fan-out thường — 022 merge lúc đọc.
  if ((followee?.followersCount ?? 0) > FEED_CONFIG.celebrityThreshold) return;

  const { CREATE, EDIT, REPOST } = PostConstants.ACTIONS;
  const visibilityQuery = await buildVisibilityQuery(followerUid, [followeeId]);
  const posts: any[] = await Post.find(
    {
      authorId: followeeId,
      type: { $in: [CREATE, EDIT, REPOST] },
      createdAt: { $gte: activeCutoff() },
      ...visibilityQuery,
    },
    { _id: 1, createdAt: 1 },
  )
    .sort({ createdAt: -1 })
    .limit(FEED_CONFIG.zsetMaxSize)
    .lean();
  if (posts.length === 0) return;

  const entries = posts.map((p) => ({
    postId: String(p._id),
    scoreMs: new Date(p.createdAt).getTime(),
  }));
  await zAddPostsForUser(followerUid, entries);
};

/**
 * Gỡ bài của followee vừa unfollow khỏi ZSET của follower — đối xứng với `backfillFeedOnFollow`.
 * `ZREM` chọn lọc (không `DEL` cả key) để không phá bài của các followee khác đang có trong cùng
 * ZSET. Cùng cửa sổ `activeCutoff()` — bài ngoài cửa sổ này vốn đã không còn khả năng nằm trong
 * ZSET (đã bị trim theo rank hoặc chưa từng được ghi).
 */
export const removeFeedOnUnfollow = async (
  followerId: any,
  followeeId: any,
): Promise<void> => {
  if (!FEED_CONFIG.fanoutEnabled) return;

  const { CREATE, EDIT, REPOST } = PostConstants.ACTIONS;
  const posts: { _id: unknown }[] = await Post.find(
    {
      authorId: followeeId,
      type: { $in: [CREATE, EDIT, REPOST] },
      createdAt: { $gte: activeCutoff() },
    },
    { _id: 1 },
  ).lean();
  if (posts.length === 0) return;

  await zRemovePostsForUser(
    String(followerId),
    posts.map((p) => String(p._id)),
  );
};
