import { getRedisInstance } from "../../../dbs/redis.ts";
import { FEED_CONFIG } from "./config.ts";

export const BATCH_SIZE = 2000;

const client = (op: string) => {
  const r = getRedisInstance();
  if (!r) {
    console.warn(`[feed-zset] ${op}: redis chưa init (instance=null) — no-op`);
    return null;
  }
  return r;
};

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
