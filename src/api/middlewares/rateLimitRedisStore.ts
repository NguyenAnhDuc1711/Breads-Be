import { randomUUID } from "node:crypto";
import type { ClientRateLimitInfo, Store } from "express-rate-limit";
import type { Redis } from "ioredis";
import { getRedisInstance } from "../../dbs/redis.ts";

// AD-1 (epic rate-limit-algorithms): Sliding Window Log qua Redis ZSET — cùng mô hình mà
// `SocketRateLimiter.check()` (`src/socket/middlewares/rateLimiter.ts`) đã chạy production, chỉ
// khác nơi lưu trạng thái (ZSET thay vì `Map`). Cài đặt như 1 `Store` của `express-rate-limit`
// thay vì middleware mới để giữ nguyên toàn bộ hành vi 429/`Retry-After`/`standardHeaders`.
//
// KHÔNG xử lý fail-open/debounce ở đây — lỗi Redis được propagate lên trên, task 002 bọc thêm.

// AD-4: toàn bộ check-and-increment chạy trong 1 script Lua => atomic, không có khoảng hở TOCTOU
// giữa ZCARD và ZADD khi nhiều request tới đồng thời.
//
// Trả `count + 1` ở CẢ 2 nhánh nhưng chỉ ZADD ở nhánh dưới ngưỡng: `express-rate-limit` chặn khi
// `totalHits > limit` (dist/index.mjs:1006) nên nhánh blocked phải trả 6 (không phải 5) mới chặn
// được; đồng thời KHÔNG ghi lần gọi bị chặn vào log — đúng ngữ nghĩa `SocketRateLimiter` (request
// bị chặn không đẩy cửa sổ trượt về phía trước, tránh kéo dài hình phạt vô hạn khi bị dội).
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

// R-5: namespace riêng để key rate-limit (sinh từ `rateLimitKeyGenerator`, có thể chỉ là 1 IP thô)
// không đụng key của feed/cache đang dùng chung Redis instance.
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

// AD-2 / ARCH-1 (plan-review, CRITICAL): connection PHẢI tạo lazy. `app.ts` import `rateLimiter.ts`
// (kéo theo file này) ở đầu file, còn `initRedis()` là statement chạy sau — theo ngữ nghĩa ESM,
// module body này chạy xong TRƯỚC `initRedis()`, nên `getRedisInstance()` chắc chắn `null` ở module
// scope và `.duplicate()` sẽ crash app lúc khởi động. Cùng lý do `socket.ts` gọi `.duplicate()`
// bên trong `initSocket()`.
const getDedicatedClient = (): SlidingWindowRedis => {
  if (!dedicatedClient) {
    const base = getRedisInstance();
    if (!base) {
      throw new Error(
        "Redis chưa khởi tạo — initRedis() phải chạy trước request đầu tiên"
      );
    }
    // NFR-1: `commandTimeout` CHỈ đặt trên connection riêng này. Đặt lên client dùng chung sẽ cắt
    // luôn mọi lệnh Socket.IO adapter/cache hợp lệ nhưng lâu hơn 100ms (T-R2).
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
  // Redis-backed => key dùng chung giữa các instance; `prefix` để `singleCount` validation của
  // `express-rate-limit` không báo nhầm double-count với limiter khác cùng key generator.
  localKeys: false,
  prefix: KEY_PREFIX,

  increment: async (key: string): Promise<ClientRateLimitInfo> => {
    const now = Date.now();
    // AD-4: member PHẢI unique mỗi lần gọi. Dùng timestamp thô thì 2 request cùng millisecond có
    // cùng score VÀ cùng member -> ZADD ghi đè thay vì thêm phần tử (undercount, lọt quá `max`).
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

  // No-op: không route nào dùng `skipFailedRequests`/`skipSuccessfulRequests`, và với Sliding
  // Window Log không có "hoàn lại" 1 entry cụ thể một cách xác định. Vẫn phải export để thoả `Store`.
  decrement: () => {},

  resetKey: async (key: string): Promise<void> => {
    await getDedicatedClient().del(`${KEY_PREFIX}${key}`);
  },
});
