// Run with Node's built-in test runner: `npm test`.
//
// Phạm vi: Task 012 (security-hardening, FR-1) — tiered rate limiting (auth-tier 5/phút, global-tier
// 100/phút, in-memory store — AD-2, KHÔNG Redis).
//
// `rateLimiter.ts` không mở Mongo/Redis/Cloudinary lúc import (chỉ gọi `express-rate-limit`), nên có
// thể import trực tiếp an toàn — khác với các file route (AD-7). Mỗi test dùng `createRateLimiter(...)`
// TỰ TẠO 1 limiter instance riêng (không dùng chung `authTierLimiter`/`globalTierLimiter` export sẵn)
// để tránh state (bộ đếm in-memory) rò rỉ giữa các test chạy trên cùng 127.0.0.1.
import assert from "node:assert/strict";
import { once } from "node:events";
import fsp from "node:fs/promises";
import { test } from "node:test";
import express from "express";
import { createRateLimiter } from "./rateLimiter.ts";

const withServer = async (app, fn: (base: string) => Promise<void>) => {
  const server = app.listen(0);
  await once(server, "listening");
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
};

/* --------------------------------------------------------------- hành vi: auth-tier (max 5) */

test("FR-1: request thứ 6 trong window bị 429 kèm Retry-After, 5 request đầu vẫn 200", async () => {
  const app = express();
  app.get("/t", createRateLimiter({ windowMs: 60_000, max: 5 }), (_req, res) =>
    res.json({ ok: true })
  );

  await withServer(app, async (base) => {
    for (let i = 1; i <= 5; i++) {
      const res = await fetch(`${base}/t`);
      assert.equal(res.status, 200, `request thứ ${i} phải qua được`);
    }
    const sixth = await fetch(`${base}/t`);
    assert.equal(sixth.status, 429, "request thứ 6 phải bị chặn");
    assert.ok(sixth.headers.get("retry-after"), "response 429 phải có header Retry-After");
  });
});

/* ------------------------------------------------------------- hành vi: global-tier (max 100) */

test("FR-1: global-tier trả 429 sau khi vượt ngưỡng cấu hình (dùng ngưỡng nhỏ hơn để test nhanh)", async () => {
  const app = express();
  // Dùng max=3 thay vì 100 thật để test chạy nhanh — cùng cơ chế đếm/reject, chỉ khác con số.
  app.get("/t", createRateLimiter({ windowMs: 60_000, max: 3 }), (_req, res) =>
    res.json({ ok: true })
  );

  await withServer(app, async (base) => {
    for (let i = 1; i <= 3; i++) {
      assert.equal((await fetch(`${base}/t`)).status, 200);
    }
    assert.equal((await fetch(`${base}/t`)).status, 429);
  });
});

test("FR-1: 2 route dùng 2 limiter instance riêng -> đếm độc lập, không ảnh hưởng lẫn nhau", async () => {
  const app = express();
  app.get("/a", createRateLimiter({ windowMs: 60_000, max: 2 }), (_req, res) =>
    res.json({ ok: true })
  );
  app.get("/b", createRateLimiter({ windowMs: 60_000, max: 2 }), (_req, res) =>
    res.json({ ok: true })
  );

  await withServer(app, async (base) => {
    assert.equal((await fetch(`${base}/a`)).status, 200);
    assert.equal((await fetch(`${base}/a`)).status, 200);
    assert.equal((await fetch(`${base}/a`)).status, 429, "/a đã hết quota riêng của nó");
    assert.equal((await fetch(`${base}/b`)).status, 200, "/b có limiter riêng, chưa bị ảnh hưởng");
  });
});

/* ------------------------------------------------------------------------- cấu hình mặc định */

// (epic rate-limit-algorithms, task 020 — cutover) Test này TRƯỚC ĐÂY assert singleton
// `authTierLimiter` chặn ở request thứ 6. Sau cutover, singleton đó đếm bằng Redis, nên ngưỡng
// 5/phút của nó CHỈ đúng khi `initRedis()` đã chạy — file này cố ý KHÔNG mở Redis (xem comment
// đầu file), nên ở đây nó fail-open theo đúng AD-3. Assertion ngưỡng 5/phút KHÔNG bị bỏ: nó được
// chuyển sang `rateLimitRedisStore.test.ts` ("FR-6 (cutover): authTierLimiter (singleton thật)
// chặn request thứ 6 bằng store Redis"), nơi đã có sẵn harness Redis thật + skip-gate.
//
// Giữ lại 1 assertion ở đây vì nó pin đúng tính chất AN TOÀN quan trọng nhất của AD-3, cái mà
// file kia (chạy CÓ Redis) không thể chứng minh: Redis không khả dụng thì auth-tier CHO QUA chứ
// không khoá sạch đăng nhập/đăng ký của mọi user (fail-open, không phải fail-closed).
test("AD-3 (rate-limit-algorithms): authTierLimiter fail-open khi Redis chưa khởi tạo (không fail-closed)", async () => {
  const { authTierLimiter } = await import("./rateLimiter.ts");
  const app = express();
  app.get("/t", authTierLimiter, (_req, res) => res.json({ ok: true }));

  await withServer(app, async (base) => {
    // 6 request > max 5: nếu policy là fail-closed (hoặc store ném lỗi ra ngoài middleware) thì
    // request thứ 6 (hoặc sớm hơn) sẽ không còn là 200.
    for (let i = 1; i <= 6; i++) {
      assert.equal(
        (await fetch(`${base}/t`)).status,
        200,
        `request ${i}/6 phải qua — Redis không khả dụng thì fail-open`
      );
    }
  });
});

test("FR-1: globalTierLimiter export sẵn (singleton) đúng ngưỡng mặc định 100/phút", async () => {
  const { globalTierLimiter } = await import("./rateLimiter.ts");
  const app = express();
  app.get("/t", globalTierLimiter, (_req, res) => res.json({ ok: true }));

  await withServer(app, async (base) => {
    for (let i = 1; i <= 100; i++) {
      const res = await fetch(`${base}/t`);
      assert.equal(res.status, 200, `request ${i}/100`);
    }
    assert.equal((await fetch(`${base}/t`)).status, 429, "request thứ 101 phải bị chặn");
  });
});

/* --------------------------------------------- source assertion: wiring đúng route, không Redis */

const readSrc = (path: string) => fsp.readFile(path, "utf8");

test("FR-1: rateLimiter.ts KHÔNG import rate-limit-redis (AD-2 — in-memory only, 1 instance)", async () => {
  const src = await readSrc("src/api/middlewares/rateLimiter.ts");
  // Comment được PHÉP nhắc "rate-limit-redis" như ghi chú hướng tương lai (PRD C-1) — chỉ cấm
  // IMPORT/require thật, không cấm nhắc tên package trong doc.
  assert.ok(
    !/from\s+["']rate-limit-redis["']|require\(\s*["']rate-limit-redis["']\s*\)/.test(src),
    "AD-2: không được import rate-limit-redis — dùng in-memory store"
  );
  assert.ok(!src.includes("new RedisStore"), "AD-2: không dùng Redis store cho rate-limit");
  assert.ok(
    !/trust proxy["'\s,:)]/i.test(src) || src.includes("KHÔNG bật"),
    "không được bật trust proxy ngầm định"
  );
});

test("FR-1: app.ts mount globalTierLimiter cho API_PREFIX", async () => {
  const src = await readSrc("src/app.ts");
  assert.ok(
    /app\.use\(\s*API_PREFIX\s*,\s*globalTierLimiter\s*,\s*router\s*\)/.test(src),
    "globalTierLimiter phải mount trước router trên đường dẫn API_PREFIX"
  );
});

// Chỉ đòi hỏi authTierLimiter có mặt TRONG chain của route đó (không đòi vị trí tương đối với
// express.json/mongoSanitize — Task 013 chèn mongoSanitize()/hpp() ngay sau express.json để
// sanitize được req.body, đẩy authTierLimiter xuống sau; thứ tự này không ảnh hưởng an toàn vì
// express.json/mongoSanitize/authTierLimiter độc lập với nhau).
test("FR-1: SIGN_UP/LOGIN/CRAWL_USER trong user.route.ts có authTierLimiter", async () => {
  const src = await readSrc("src/api/routers/user.route.ts");
  const code = src.replace(/^\s*\/\/.*$/gm, "");

  const routeBlock = (key: string) => {
    const startIdx = code.indexOf(`router.post(\n  ${key},`);
    assert.ok(startIdx !== -1, `phải tìm thấy route ${key}`);
    const endIdx = code.indexOf(");", startIdx);
    return code.slice(startIdx, endIdx);
  };

  assert.ok(
    routeBlock("SIGN_UP").includes("authTierLimiter"),
    "SIGN_UP phải có authTierLimiter trong chain"
  );
  assert.ok(
    routeBlock("LOGIN").includes("authTierLimiter"),
    "LOGIN phải có authTierLimiter trong chain"
  );
  assert.ok(
    code.includes("router.post(CRAWL_USER, authTierLimiter,"),
    "CRAWL_USER phải có authTierLimiter (AD-3 — không loại trừ)"
  );
});

test("FR-1: CRAWL_POST trong post.route.ts có authTierLimiter (AD-3 — không loại trừ)", async () => {
  const src = await readSrc("src/api/routers/post.route.ts");
  const code = src.replace(/^\s*\/\/.*$/gm, "");
  assert.ok(
    code.includes("router.post(CRAWL_POST, authTierLimiter,"),
    "CRAWL_POST phải có authTierLimiter"
  );
});

// Bước 2 (access-control-hardening): `POST /util/send-forgot-pw-mail` đã bị xoá, luồng quên mật
// khẩu chuyển sang 3 route `password-reset/*` trong `user.route.ts`. Cùng lý do auth-tier như cũ
// (spam gửi mail) và thêm một lý do mới: brute-force mã OTP 6 ký tự.
test("FR-1: 3 route password-reset trong user.route.ts đều có authTierLimiter trước validate", async () => {
  const src = await readSrc("src/api/routers/user.route.ts");
  const code = src.replace(/^\s*\/\/.*$/gm, "");
  for (const schema of [
    "requestPasswordResetSchema",
    "verifyPasswordResetCodeSchema",
    "confirmPasswordResetSchema",
  ]) {
    assert.ok(
      code.includes(`authTierLimiter,\n  validate(${schema})`),
      `${schema} phải có authTierLimiter đứng ngay trước validate`
    );
  }
});

test("FR-1: cron job (updateUsersCatesCron) không đụng rate-limit", async () => {
  const src = await readSrc("src/cronjob/index.ts").catch(() =>
    readSrc("src/cronjob/index.js")
  );
  assert.ok(
    !src.includes("rateLimiter") && !src.includes("RateLimiter"),
    "cron job không đi qua HTTP, không cần/không được đụng rate-limit middleware"
  );
});
