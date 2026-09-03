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

test("FR-1: global-tier trả 429 sau khi vượt ngưỡng cấu hình (dùng ngưỡng nhỏ hơn để test nhanh)", async () => {
  const app = express();
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

test("AD-3 (rate-limit-algorithms): authTierLimiter fail-open khi Redis chưa khởi tạo (không fail-closed)", async () => {
  const { authTierLimiter } = await import("./rateLimiter.ts");
  const app = express();
  app.get("/t", authTierLimiter, (_req, res) => res.json({ ok: true }));

  await withServer(app, async (base) => {
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

const readSrc = (path: string) => fsp.readFile(path, "utf8");

test("FR-1: rateLimiter.ts KHÔNG import rate-limit-redis (AD-2 — in-memory only, 1 instance)", async () => {
  const src = await readSrc("src/api/middlewares/rateLimiter.ts");
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
