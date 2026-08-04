import { getRedisInstance } from "../../../dbs/redis.ts";
import { FEED_CONFIG } from "./config.ts";

const BATCH_SIZE = 2000;

const client = (op: string) => {
  const r = getRedisInstance();
  if (!r) {
    console.warn(`[feed-zset] ${op}: redis chưa init (instance=null) — no-op`);
    return null;
  }
  return r;
};

const chunk = <T>(arr: T[], size: number): T[][] => {
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
      await pipeline.exec();
    } catch (err) {
      console.error("[feed-zset] zAddPostForUsers failed:", err);
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
      await pipeline.exec();
      return;
    }
    const zaddArgs = entries.flatMap(({ postId, scoreMs }) => [scoreMs, postId]);
    pipeline.zadd(key, ...zaddArgs);
    pipeline.zremrangebyrank(key, 0, -(FEED_CONFIG.zsetMaxSize + 1));
    pipeline.expire(key, FEED_CONFIG.activeWindowDays * 86400);
    await pipeline.exec();
  } catch (err) {
    console.error("[feed-zset] zReplaceUserFeed failed:", err);
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
