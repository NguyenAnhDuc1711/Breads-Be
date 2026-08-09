import { getRedisInstance } from "../../../dbs/redis.ts";
import { FEED_CONFIG } from "./config.ts";

/** Kích thước 1 pipeline ZSET write. Export để dispatch worker (010) chia follower list theo ĐÚNG
 * cùng hằng số — batch job ≤ `BATCH_SIZE` follower thì `zAddPostForUsers` bên trong chỉ chạy đúng
 * 1 `pipeline.exec()`, không chunk lại lần nữa. */
export const BATCH_SIZE = 2000;

const client = (op: string) => {
  const r = getRedisInstance();
  if (!r) {
    console.warn(`[feed-zset] ${op}: redis chưa init (instance=null) — no-op`);
    return null;
  }
  return r;
};

// ioredis's pipeline.exec() resolves with a [error, result][] tuple array —
// it does NOT reject the whole pipeline just because some commands failed
// (only a connection-level failure to send does, which enableOfflineQueue:
// false already turns into a rejection our try/catch handles). Without this
// check, individual command errors inside an otherwise-resolved pipeline
// were being silently swallowed.
const logPipelineErrors = (
  op: string,
  results: [Error | null, unknown][] | null
): void => {
  if (!results) return;
  const errors = results.filter(([err]) => err);
  if (errors.length > 0) {
    console.error(
      `[feed-zset] ${op}: ${errors.length}/${results.length} command(s) failed:`,
      errors.map(([err]) => err?.message)
    );
  }
};

export const chunk = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
};

export const feedKey = (userId: string): string => `feed:zset:${userId}`;

export const zRevRangeTop = async (
  userId: string,
  count: number
): Promise<string[]> => {
  const r = client("zRevRangeTop");
  if (!r) return [];
  try {
    return await r.zrevrange(feedKey(userId), 0, count - 1);
  } catch (err) {
    console.error("[feed-zset] zRevRangeTop failed:", err);
    return [];
  }
};

export const zExists = async (userId: string): Promise<boolean> => {
  const r = client("zExists");
  if (!r) return false;
  try {
    return (await r.exists(feedKey(userId))) === 1;
  } catch (err) {
    console.error("[feed-zset] zExists failed:", err);
    return false;
  }
};

export const zAddPostForUsers = async (
  userIds: string[],
  postId: string,
  scoreMs: number
): Promise<void> => {
  const r = client("zAddPostForUsers");
  if (!r) return;

  for (const batch of chunk(userIds, BATCH_SIZE)) {
    try {
      const pipeline = r.pipeline();
      for (const userId of batch) {
        const key = feedKey(userId);
        pipeline.zadd(key, scoreMs, postId);
        pipeline.zremrangebyrank(key, 0, -(FEED_CONFIG.zsetMaxSize + 1));
        pipeline.expire(key, FEED_CONFIG.activeWindowDays * 86400);
      }
      const results = await pipeline.exec();
      logPipelineErrors("zAddPostForUsers", results);
    } catch (err) {
      console.error("[feed-zset] zAddPostForUsers failed:", err);
    }
  }
};

/**
 * Biến thể throw của `zAddPostForUsers` — logic pipeline giống hệt (dùng chung `chunk`/`client`)
 * nhưng KHÔNG nuốt lỗi: mọi command lỗi trong pipeline (hoặc lỗi gửi pipeline) đều re-throw. Dùng
 * riêng cho batch worker (task 011/AD-3) để BullMQ thấy job thật sự lỗi và retry (FR-6) — gọi
 * thẳng `zAddPostForUsers` gốc ở đây sẽ luôn ra job `completed` giả kể cả khi ghi Redis thất bại.
 * `zAddPostForUsers` gốc giữ nguyên không đổi, vẫn dùng cho nhánh `direct`/mọi caller khác cần hợp
 * đồng "không bao giờ throw".
 */
export const zAddPostForUsersOrThrow = async (
  userIds: string[],
  postId: string,
  scoreMs: number
): Promise<void> => {
  const r = client("zAddPostForUsersOrThrow");
  if (!r) throw new Error("[feed-zset] zAddPostForUsersOrThrow: redis instance null");

  for (const batch of chunk(userIds, BATCH_SIZE)) {
    const pipeline = r.pipeline();
    for (const userId of batch) {
      const key = feedKey(userId);
      pipeline.zadd(key, scoreMs, postId);
      pipeline.zremrangebyrank(key, 0, -(FEED_CONFIG.zsetMaxSize + 1));
      pipeline.expire(key, FEED_CONFIG.activeWindowDays * 86400);
    }
    const results = await pipeline.exec();
    const errors = (results ?? []).filter(([err]) => err);
    if (errors.length > 0) {
      throw new Error(
        `[feed-zset] zAddPostForUsersOrThrow: ${errors.length}/${results!.length} command(s) failed`
      );
    }
  }
};

export const zReplaceUserFeed = async (
  userId: string,
  entries: { postId: string; scoreMs: number }[]
): Promise<void> => {
  const r = client("zReplaceUserFeed");
  if (!r) return;

  const key = feedKey(userId);
  try {
    const pipeline = r.pipeline();
    pipeline.del(key);
    if (entries.length === 0) {
      const results = await pipeline.exec();
      logPipelineErrors("zReplaceUserFeed", results);
      return;
    }
    const zaddArgs = entries.flatMap(({ postId, scoreMs }) => [scoreMs, postId]);
    pipeline.zadd(key, ...zaddArgs);
    pipeline.zremrangebyrank(key, 0, -(FEED_CONFIG.zsetMaxSize + 1));
    pipeline.expire(key, FEED_CONFIG.activeWindowDays * 86400);
    const results = await pipeline.exec();
    logPipelineErrors("zReplaceUserFeed", results);
  } catch (err) {
    console.error("[feed-zset] zReplaceUserFeed failed:", err);
  }
};

/** ZADD nhiều bài vào ZSET đã có sẵn của MỘT user, không `DEL` trước — dùng khi backfill bài của
 * một followee mới vào feed đang có bài của các followee khác (khác `zReplaceUserFeed`, hàm đó
 * thay thế toàn bộ key). */
export const zAddPostsForUser = async (
  userId: string,
  entries: { postId: string; scoreMs: number }[]
): Promise<void> => {
  if (entries.length === 0) return;
  const r = client("zAddPostsForUser");
  if (!r) return;

  const key = feedKey(userId);
  try {
    const pipeline = r.pipeline();
    const zaddArgs = entries.flatMap(({ postId, scoreMs }) => [scoreMs, postId]);
    pipeline.zadd(key, ...zaddArgs);
    pipeline.zremrangebyrank(key, 0, -(FEED_CONFIG.zsetMaxSize + 1));
    pipeline.expire(key, FEED_CONFIG.activeWindowDays * 86400);
    const results = await pipeline.exec();
    logPipelineErrors("zAddPostsForUser", results);
  } catch (err) {
    console.error("[feed-zset] zAddPostsForUser failed:", err);
  }
};

/** ZREM chọn lọc — gỡ đúng các `postId` khỏi ZSET của MỘT user, không đụng bài của followee khác
 * trong cùng key. Dùng khi unfollow, thay cho `zDeleteUserFeeds` (hàm đó xoá cả key). */
export const zRemovePostsForUser = async (
  userId: string,
  postIds: string[]
): Promise<void> => {
  if (postIds.length === 0) return;
  const r = client("zRemovePostsForUser");
  if (!r) return;
  try {
    await r.zrem(feedKey(userId), ...postIds);
  } catch (err) {
    console.error("[feed-zset] zRemovePostsForUser failed:", err);
  }
};

export const zDeleteUserFeeds = async (userIds: string[]): Promise<void> => {
  const r = client("zDeleteUserFeeds");
  if (!r) return;

  for (const batch of chunk(userIds, BATCH_SIZE)) {
    try {
      const keys = batch.map(feedKey);
      await r.del(...keys);
    } catch (err) {
      console.error("[feed-zset] zDeleteUserFeeds failed:", err);
    }
  }
};
