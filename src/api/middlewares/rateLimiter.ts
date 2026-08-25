import type { Request } from "express";
import rateLimit from "express-rate-limit";
import type { Store } from "express-rate-limit";
import { authRedisStore } from "./rateLimitRedisStore.ts";

// FR-1 (security-hardening, task 012). Store mặc định của `createRateLimiter` vẫn là in-memory của
// `express-rate-limit` — `globalTierLimiter`/`mediaSignLimiter` dùng đúng store đó, KHÔNG đổi
// (NFR-2, epic rate-limit-algorithms). RIÊNG `authTierLimiter` đã chuyển sang Redis-backed
// (Sliding Window Log) từ task 020 — lý do chi tiết ở khối comment ngay trên `authTierLimiter`.
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

// (epic rate-limit-algorithms, task 020 — Migration Plan bước 3 "cutover") `authTierLimiter` giờ
// đếm bằng `authRedisStore` (Redis) thay vì Fixed Window in-memory. 3 câu hỏi "vì sao" cần trả lời
// được mà KHÔNG phải tra PRD/epic/lịch sử commit:
//
// (i) VÌ SAO Sliding Window Log (ZSET lưu timestamp từng request), không phải Fixed Window cũ /
//     Sliding Window Counter / Token Bucket: Fixed Window (mặc định của express-rate-limit) reset
//     bộ đếm theo BIÊN cửa sổ, nên kẻ tấn công canh đúng biên gửi được 2*max = 10 lần thử mật khẩu
//     trong ~1 giây mà vẫn "đúng luật" — đây là lỗ hổng epic này sinh ra để đóng. Sliding Window
//     Counter chỉ NỘI SUY giữa 2 cửa sổ (vẫn còn sai số quanh biên) và ưu thế của nó là tiết kiệm
//     bộ nhớ ở tải lớn — vô nghĩa khi `max = 5` (tối đa 5 phần tử/key). Token Bucket thì CỐ Ý cho
//     phép burst (tiêu token dự trữ) — ngược hẳn mục tiêu chống brute-force. Sliding Window Log cho
//     độ chính xác tuyệt đối với chi phí không đáng kể ở quy mô này, và là đúng mô hình mà
//     `SocketRateLimiter` (`src/socket/middlewares/rateLimiter.ts`) đã chạy production, chỉ khác
//     nơi lưu trạng thái.
//
// (ii) VÌ SAO fail-open (Redis lỗi -> CHO QUA) chứ không fail-closed: Redis ở đây là 1 instance
//      đơn, KHÔNG có failover. Fail-closed sẽ biến mọi lần restart/hiccup Redis thành outage
//      đăng nhập/đăng ký cho MỌI user — blast radius lớn hơn nhiều so với việc tạm mất 1 lớp
//      rate-limit trong vài trăm ms. Route auth-tier vẫn còn các lớp không phụ thuộc Redis
//      (bcrypt làm chậm từng lần thử mật khẩu, `globalTierLimiter` in-memory bên dưới). Chi tiết
//      cơ chế + debounce 2-lỗi-liên-tiếp: xem `rateLimitRedisStore.ts`.
//
// (iii) VÌ SAO connection Redis khởi tạo LAZY (bên trong `increment()`, không ở module scope):
//       `app.ts` import file này Ở ĐẦU file còn `initRedis()` chạy SAU — theo ngữ nghĩa ESM, module
//       body này chạy xong TRƯỚC khi Redis kịp khởi tạo, nên `.duplicate()` ở module scope sẽ gọi
//       trên `null` và crash app 100% lúc khởi động. Cùng lý do `socket.ts` gọi `.duplicate()` bên
//       trong `initSocket()`.
//
// NFR-1 (ngân sách latency) — ĐÃ CHỐT bằng benchmark thực đo 2026-08-25
// (`test/results/rate-limit-auth-benchmark-20260825T061411Z.json`, N=500): p95 Redis-backed 0.15ms
// vs in-memory 0ms => delta p95 = 0.14ms, dưới ngân sách 20ms tới hơn 2 bậc độ lớn; tỷ lệ lỗi/
// timeout Redis 0/500 = 0%. Vì vậy GIỮ NGUYÊN `commandTimeout = 100ms` và debounce = 2 lỗi liên
// tiếp (`rateLimitRedisStore.ts`), không nới lỏng: biên độ hiện tại đủ rộng để 100ms chỉ chạm tới
// khi Redis thật sự bất thường (~700x p95), còn 0% lỗi nghĩa là không có false-positive nào ép
// phải tăng debounce lên 3. Lưu ý provenance: số đo LOCAL (Redis + Node cùng máy), chưa phải
// staging/production — nếu sau này deploy sau network thật, đo lại trước khi siết `commandTimeout`.
export const authTierLimiter = createRateLimiter({
  windowMs: AUTH_TIER_WINDOW_MS,
  max: AUTH_TIER_MAX,
  store: authRedisStore,
});

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
