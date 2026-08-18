import rateLimit from "express-rate-limit";

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
}: {
  windowMs: number;
  max: number;
  message?: string;
}) =>
  rateLimit({
    windowMs,
    max,
    message: message ?? "Too many requests, please try again later",
    standardHeaders: true, // trả RateLimit-* header + Retry-After (IETF draft)
    legacyHeaders: false, // tắt X-RateLimit-* cũ, tránh trùng lặp
  });

// Auth-tier: SIGN_UP/LOGIN/forgot-password (util.route.ts) + CRAWL_POST/CRAWL_USER (AD-3 — 2 route
// này thiếu auth guard, không loại trừ khỏi rate-limit, xem PRD C-4).
export const authTierLimiter = createRateLimiter({ windowMs: 60_000, max: 5 });

// Global-tier: toàn bộ /api còn lại. Route đã có authTierLimiter riêng vẫn nhận thêm global-tier
// (2 lớp rate-limit độc lập, lớp nghiêm ngặt hơn trigger trước — không xung đột).
export const globalTierLimiter = createRateLimiter({ windowMs: 60_000, max: 100 });

// Media-sign tier (epic presigned-media-upload, AD-3 + FR-6): endpoint ký batch upload Cloudinary.
// Cùng cơ chế `createRateLimiter` với 2 limiter trên — KHÔNG phải `messageSendLimiter`/
// `messageActionLimiter` ở `src/socket/middlewares/rateLimiter.ts` (SocketRateLimiter, cửa sổ theo
// giây, dành cho throughput socket liên tục).
//
// 20/phút thay vì 5 như authTierLimiter: FR-1/FR-2 gộp theo BATCH (1 lần gọi cho cả hành động
// compose, không phải 1 lần/file), nên 5/phút sẽ chặn nhầm user soạn nhiều tin/post liên tiếp.
export const mediaSignLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });
