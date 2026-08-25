import type { NextFunction, Request, Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Store } from "express-rate-limit";
import { authRedisStore } from "./rateLimitRedisStore.ts";
import logger from "../../core/logger.ts";

// FR-1 (security-hardening, task 012). AD-2 (epic.md): DATN-Be hiện chỉ chạy 1 instance -> dùng
// thẳng in-memory store mặc định của express-rate-limit, KHÔNG cần Redis. Nếu sau này mở rộng
// multi-instance, chuyển sang `rate-limit-redis` (Redis đã sẵn có qua `initRedis()` trong app.ts).
//
// KHÔNG bật `trust proxy` ở đây/app.ts: mặc định Express không tin `X-Forwarded-For`, nên
// `req.ip` luôn là địa chỉ kết nối TCP thật, không thể giả mạo qua header. Nếu sau này deploy sau
// reverse proxy/load-balancer thật, cần `app.set("trust proxy", ...)` với giá trị khớp đúng số hop
// tin cậy — làm sai (vd "true") sẽ cho phép client tự set X-Forwarded-For để né rate-limit.
export const createRateLimiter = ({
  windowMs,
  max,
  message,
  skip,
  store,
}: {
  windowMs: number;
  max: number;
  message?: string;
  skip?: (req: Request) => boolean;
  store?: Store; // task 003 (rate-limit-algorithms, AD-5): optional, không truyền => in-memory mặc định
}) =>
  rateLimit({
    windowMs,
    max,
    message: message ?? "Too many requests, please try again later",
    standardHeaders: true, // trả RateLimit-* header + Retry-After (IETF draft)
    legacyHeaders: false, // tắt X-RateLimit-* cũ, tránh trùng lặp
    ...(skip ? { skip } : {}),
    ...(store ? { store } : {}),
  });

// Auth-tier: SIGN_UP/LOGIN/forgot-password (util.route.ts) + CRAWL_POST/CRAWL_USER (AD-3 — 2 route
// này thiếu auth guard, không loại trừ khỏi rate-limit, xem PRD C-4).
const AUTH_TIER_WINDOW_MS = 60_000;
const AUTH_TIER_MAX = 5;

// Limiter THẬT — in-memory, chưa đổi (Migration Plan bước 1, epic rate-limit-algorithms/AD-5:
// chưa cutover, đây vẫn là limiter DUY NHẤT quyết định response cho tới task 020).
const authTierLimiterReal = createRateLimiter({
  windowMs: AUTH_TIER_WINDOW_MS,
  max: AUTH_TIER_MAX,
});

// Shadow mode (epic rate-limit-algorithms, AD-5 + PRD Migration Plan bước 1 + FR-6): quan sát
// `authRedisStore` (Sliding Window Log, task 001/002) SONG SONG với limiter in-memory thật, CHỈ để
// log/so sánh cho task 010 (test)/011 (benchmark) — KHÔNG được ảnh hưởng response thật.
//
// Gọi thẳng `authRedisStore.increment()` thay vì bọc lại 1 `rateLimit()` middleware đầy đủ: middleware
// đầy đủ của express-rate-limit tự ghi `RateLimit-*`/headers và `req.rateLimit` vào chính request/response
// thật đang xử lý (xem node_modules/express-rate-limit/dist/index.mjs, hàm `middleware` — set header cả
// khi KHÔNG bị chặn), nên không thể đảm bảo tuyệt đối "không đụng res" nếu dùng lại nguyên khối đó. Gọi
// `.increment()` trực tiếp là cách duy nhất chứng minh được KHÔNG chạm `res`/`next`.
//
// Key dùng `ipKeyGenerator(req.ip)` — chính là logic mặc định mà `authTierLimiterReal` đang dùng (không
// truyền `keyGenerator` riêng nên rơi vào default keyGenerator của express-rate-limit, cũng gọi
// `ipKeyGenerator(request.ip)` nội bộ). Bắt buộc phải khớp key này để FR-6/AD-5 "shadow quan sát ĐÚNG
// request mà limiter thật đang đếm" là đúng nghĩa, không phải 2 luồng đếm độc lập theo 2 key khác nhau.
const observeAuthTierShadow = (req: Request): void => {
  const key = ipKeyGenerator(req.ip ?? "");
  const startedAt = performance.now();
  // `Store.increment` khai báo trả `ClientRateLimitInfo | Promise<...>` (đồng bộ hoặc bất đồng bộ tuỳ
  // implementation) — bọc `Promise.resolve` để luôn `.then/.catch` được, không phân biệt 2 trường hợp.
  Promise.resolve(authRedisStore.increment(key))
    .then((result) => {
      const latencyMs = performance.now() - startedAt;
      // Format greppable cho task 011 (benchmark): field cố định `shadow`, `wouldBlock`, `totalHits`,
      // `latencyMs` — xem handoff task 003 để biết field nào KHÔNG được đổi tên.
      logger.info(
        {
          shadow: "authTierLimiter",
          wouldBlock: result.totalHits > AUTH_TIER_MAX,
          totalHits: result.totalHits,
          latencyMs: Math.round(latencyMs * 100) / 100,
        },
        "[rateLimiter] authTierLimiter shadow observation"
      );
    })
    .catch((err) => {
      // authRedisStore (task 002) đã tự fail-open + tự log warn/error cho lỗi Redis — nhánh catch này
      // chỉ chặn unhandled rejection nếu có lỗi KHÁC xảy ra (vd chính logger.info ném lỗi), không phải
      // đường đi thường gặp.
      logger.warn(
        { err },
        "[rateLimiter] authTierLimiter shadow observation lỗi không mong đợi"
      );
    });
};

// authTierLimiter giờ là 1 wrapper mỏng: (a) bắn observation tới shadow store fire-and-forget (không
// await, không đụng res/next của request thật), (b) delegate toàn quyền quyết định response cho
// `authTierLimiterReal`. Đảm bảo FR-6 (Migration Plan bước 1): MỌI request auth-tier đều được cả 2
// limiter nhìn thấy, nhưng response thật CHỈ do limiter in-memory quyết định — kể cả khi shadow store
// báo "sẽ chặn" hoặc bản thân shadow lỗi.
export const authTierLimiter = (req: Request, res: Response, next: NextFunction): void => {
  observeAuthTierShadow(req);
  authTierLimiterReal(req, res, next);
};

// Global-tier: toàn bộ /api còn lại. Route đã có authTierLimiter riêng vẫn nhận thêm global-tier
// (2 lớp rate-limit độc lập, lớp nghiêm ngặt hơn trigger trước — không xung đột).
//
// (epic seo-sitemap-schema, phát hiện + xác nhận qua live test — 3 lần thử `authTierLimiter`
// 5/phút, rồi `sitemapListLimiter` 300/phút, đều fail): `/posts/sitemap-eligible` và
// `/users/sitemap-eligible` bị TRỪ khỏi global-tier qua `skip`, và KHÔNG có limiter riêng nào áp
// cho 2 route này nữa (xem `post.route.ts`/`user.route.ts`). Root cause thật: Next.js's static
// export gọi đồng thời nhiều lần `getChunk()` phía Fe lúc build, mỗi chunk xa phải đi qua nhiều
// trang trước đó — tổng tải cộng dồn vượt BẤT KỲ ngưỡng theo-phút nào bất kể đặt cao bao nhiêu, vì
// hoàn thành nhanh hơn nhiều so với cửa sổ 60s. 2 route này đã gate bằng `sitemapAuthGate` (AD-3,
// shared-secret, server-to-server only) — đây là biên bảo mật thật; rate-limit theo phút không hợp
// với pattern gọi của loại client này (không phải user thật gõ bàn phím, mà là 1 job phân trang hết
// dataset) nên không thêm giá trị bảo mật, chỉ toàn gây false-positive.
const SITEMAP_ELIGIBLE_PATHS = new Set([
  "/posts/sitemap-eligible",
  "/users/sitemap-eligible",
]);

export const globalTierLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 100,
  skip: (req) => SITEMAP_ELIGIBLE_PATHS.has(req.path),
});

// Media-sign tier (epic presigned-media-upload, AD-3 + FR-6): endpoint ký batch upload Cloudinary.
// Cùng cơ chế `createRateLimiter` với 2 limiter trên — KHÔNG phải `messageSendLimiter`/
// `messageActionLimiter` ở `src/socket/middlewares/rateLimiter.ts` (SocketRateLimiter, cửa sổ theo
// giây, dành cho throughput socket liên tục).
//
// 20/phút thay vì 5 như authTierLimiter: FR-1/FR-2 gộp theo BATCH (1 lần gọi cho cả hành động
// compose, không phải 1 lần/file), nên 5/phút sẽ chặn nhầm user soạn nhiều tin/post liên tiếp.
export const mediaSignLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });
