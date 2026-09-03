import { randomUUID } from "node:crypto";
import type { ClientRateLimitInfo, Store } from "express-rate-limit";
import type { Redis } from "ioredis";
import { getRedisInstance } from "../../dbs/redis.ts";
import logger from "../../core/logger.ts";

const LUA_SLIDING_WINDOW = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
if count < max then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window)
  return {count + 1, now + window}
end
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
return {count + 1, tonumber(oldest[2]) + window}
`;

const KEY_PREFIX = "rl:sw:";

type SlidingWindowRedis = Redis & {
  slidingWindowCheck: (
    key: string,
    now: number,
    windowMs: number,
    max: number,
    member: string
  ) => Promise<[number, number]>;
};

let dedicatedClient: SlidingWindowRedis | null = null;

const getDedicatedClient = (): SlidingWindowRedis => {
  if (!dedicatedClient) {
    const base = getRedisInstance();
    if (!base) {
      throw new Error(
        "Redis chưa khởi tạo — initRedis() phải chạy trước request đầu tiên"
      );
    }
    dedicatedClient = base.duplicate({
      commandTimeout: 100,
    }) as SlidingWindowRedis;
    dedicatedClient.defineCommand("slidingWindowCheck", {
      numberOfKeys: 1,
      lua: LUA_SLIDING_WINDOW,
    });
  }
  return dedicatedClient;
};

export interface SlidingWindowStoreOptions {
  windowMs: number;
  max: number;
}

export const createRedisSlidingWindowStore = ({
  windowMs,
  max,
}: SlidingWindowStoreOptions): Store => ({
  localKeys: false,
  prefix: KEY_PREFIX,

  increment: async (key: string): Promise<ClientRateLimitInfo> => {
    const now = Date.now();
    const member = `${now}:${randomUUID()}`;
    const [totalHits, resetTimeMs] = await getDedicatedClient().slidingWindowCheck(
      `${KEY_PREFIX}${key}`,
      now,
      windowMs,
      max,
      member
    );
    return { totalHits, resetTime: new Date(resetTimeMs) };
  },

  decrement: () => {},

  resetKey: async (key: string): Promise<void> => {
    await getDedicatedClient().del(`${KEY_PREFIX}${key}`);
  },
});

let consecutiveFailures = 0;

const FAIL_OPEN_TOTAL_HITS = 1;

export const withFailOpen = (originalStore: Store): Store => ({
  ...originalStore,

  increment: async (key: string): Promise<ClientRateLimitInfo> => {
    try {
      const result = await originalStore.increment(key);
      consecutiveFailures = 0;
      return result;
    } catch (err) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= 2) {
        logger.error(
          { err, key, consecutiveFailures, limiter: "authTierLimiter" },
          "[rateLimitRedisStore] Redis không khả dụng — fail-open (authTierLimiter tạm thời không rate-limit)"
        );
      } else {
        logger.warn(
          { err, key, consecutiveFailures, limiter: "authTierLimiter" },
          "[rateLimitRedisStore] Redis lỗi 1 lần — chưa đủ debounce, vẫn fail-open cho request này"
        );
      }
      return { totalHits: FAIL_OPEN_TOTAL_HITS, resetTime: undefined };
    }
  },

  decrement: (key: string) => originalStore.decrement(key),
  resetKey: (key: string) => originalStore.resetKey(key),
});

export const authRedisStore: Store = withFailOpen(
  createRedisSlidingWindowStore({ windowMs: 60_000, max: 5 })
);
