import { randomUUID } from "node:crypto";
import type { ClientRateLimitInfo, Store } from "express-rate-limit";
import type { Redis } from "ioredis";
import { getRedisInstance } from "../../dbs/redis.ts";
import logger from "../../core/logger.ts";

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

// AD-3 (epic rate-limit-algorithms): Fail-OPEN khi Redis không khả dụng, KHÔNG phải fail-closed.
// Lý do (tóm tắt AD-3 — chi tiết xem epic.md): Redis hiện KHÔNG có failover (single instance) —
// fail-closed sẽ biến MỌI lần Redis restart/hiccup thành 1 lần OUTAGE TOÀN BỘ đăng nhập/đăng ký cho
// MỌI user thật, blast radius lớn hơn nhiều so với việc tạm thời thiếu 1 lớp rate-limit trong vài
// trăm ms. Route auth-tier vẫn còn các lớp bảo vệ khác không phụ thuộc Redis (bcrypt hashing,
// `globalTierLimiter` theo IP không đổi trong epic này).
//
// Debounce (NFR-1): chỉ coi Redis "down" (log `error`) sau >=2 lỗi LIÊN TIẾP — 1 lỗi thoáng qua vẫn
// fail-open CHO LẦN GỌI ĐÓ nhưng KHÔNG đổi trạng thái toàn cục (log `warn`). Debounce này đặc biệt
// quan trọng vì bản thân connection riêng (`getDedicatedClient`) CHẮC CHẮN lỗi đúng 1 lần ở lệnh đầu
// tiên sau khi app boot (`.duplicate()` kế thừa `enableOfflineQueue: false`, lệnh đầu khi socket còn
// ở status `connecting` reject ngay lập tức — xem skillbook SKL-005/handoff task 001). Nếu không có
// debounce, MỌI lần app khởi động sẽ tự kích hoạt fail-open toàn cục dù Redis hoàn toàn khoẻ mạnh.
// Vì vậy 1 lần THÀNH CÔNG PHẢI reset `consecutiveFailures` về 0 ngay lập tức — nhờ đó lỗi cold-start
// bị cô lập thành 1 sự kiện đơn lẻ, không cộng dồn với 1 lỗi thật không liên quan xảy ra sau đó.
//
// State đếm lỗi liên tiếp là MODULE-LEVEL (không per-key, epic.md task T2 "Key risk"): "Redis không
// khả dụng" là trạng thái HẠ TẦNG áp dụng chung cho mọi key, không phải trạng thái riêng từng user.
let consecutiveFailures = 0;

// totalHits trả về lúc fail-open KHÔNG được là 0: `express-rate-limit`'s `positiveHits` validation
// (node_modules/express-rate-limit/dist/index.mjs, khoảng dòng 380-390, gọi tại dòng ~902) throw
// `ValidationError` nếu `hits < 1` — trả 0 sẽ biến 1 lỗi Redis đã bắt gọn gàng thành 1 exception
// KHÔNG bắt được, ném thẳng ra khỏi middleware (tệ hơn cả không có wrapper). Giá trị AN TOÀN nhỏ
// nhất là 1: luôn nhỏ hơn `limit` (mọi route hiện tại có `max >= 5`) nên `totalHits > limit`
// (dist/index.mjs:1006) không bao giờ đúng => không bao giờ block, đồng thời là số nguyên dương hợp
// lệ nên qua được `positiveHits`.
const FAIL_OPEN_TOTAL_HITS = 1;

// `resetTime: undefined` (thay vì tự bịa 1 mốc thời gian) lúc fail-open là lựa chọn có chủ đích: đã
// xác nhận trong code thật (dist/index.mjs:761-762) `standardHeaders: true` (cấu hình đang dùng ở
// `rateLimiter.ts`) resolve thành draft-6, và `setDraft6Headers`/`getResetSeconds` xử lý
// `resetTime` rỗng bằng cách tự fallback về `config.windowMs` của middleware (không throw, không
// crash) — đây chính xác là giá trị đúng cần dùng khi Redis không khả dụng, không cần wrapper tự
// tính lại `windowMs` (mà `withFailOpen` không có, đúng chữ ký `(store: Store): Store` của Interface
// Contract). Chỉ draft-7/draft-8 mới throw khi thiếu `resetTime` — route auth-tier không dùng 2 draft
// đó.
export const withFailOpen = (originalStore: Store): Store => ({
  ...originalStore,

  increment: async (key: string): Promise<ClientRateLimitInfo> => {
    try {
      const result = await originalStore.increment(key);
      consecutiveFailures = 0; // Reset ngay khi thành công — xem giải thích cold-start ở trên.
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

  // `resetKey`/`decrement` KHÔNG fail-open: đây không phải luồng request thật (test/admin thao tác
  // trực tiếp) — để lỗi lộ ra thay vì nuốt âm thầm, đúng Interface Contract của task này.
  decrement: (key: string) => originalStore.decrement(key),
  resetKey: (key: string) => originalStore.resetKey(key),
});

// Export cuối cùng — task 003 import thẳng vào `rateLimiter.ts` (Interface Contract).
export const authRedisStore: Store = withFailOpen(
  createRedisSlidingWindowStore({ windowMs: 60_000, max: 5 })
);
