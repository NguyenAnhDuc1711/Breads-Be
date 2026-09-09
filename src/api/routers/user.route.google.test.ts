import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import express from "express";
import { z } from "zod";
import Redis from "ioredis";
import { ipKeyGenerator } from "express-rate-limit";
import { googleLoginSchema } from "../validators/user.validator.ts";
import userRouter from "./user.route.ts";
import { VALIDATION_ERROR_MESSAGE } from "../middlewares/validate.ts";
import { authTierLimiter } from "../middlewares/rateLimiter.ts";
import initRedis, { getRedisInstance } from "../../dbs/redis.ts";
import { createRedisSlidingWindowStore } from "../middlewares/rateLimitRedisStore.ts";

const errorHandler = (err, _req, res, _next) => {
  const statusCode = err.statusCode || err.status || 500;
  res.status(statusCode).json({ message: err.message });
};

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

const mountUserRouter = () => {
  const app = express();
  app.use(express.json());
  app.use("/users", userRouter);
  app.use(errorHandler);
  return app;
};

// ── Redis availability probe (giống rateLimitRedisStore.test.ts) ──────────
// authTierLimiter fail-open khi Redis không khả dụng (AD-3), nên test 429
// thật (request thứ 6) chỉ có ý nghĩa khi có Redis — bỏ qua nếu không có.
const probeRedis = async (): Promise<string | false> => {
  const probe = new Redis({
    host: process.env.REDIS_HOST || "localhost",
    port: Number(process.env.REDIS_PORT || 6379),
    lazyConnect: true,
    connectTimeout: 1000,
    retryStrategy: () => null,
    maxRetriesPerRequest: 1,
  });
  probe.on("error", () => {});
  try {
    await probe.connect();
    await probe.ping();
    return false;
  } catch {
    return "Redis không khả dụng (REDIS_HOST/REDIS_PORT, mặc định localhost:6379) — bỏ qua test cần Redis thật";
  } finally {
    probe.disconnect();
  }
};
const skipNoRedis = await probeRedis();
const needsRedis = { skip: skipNoRedis };

// ── 1) googleLoginSchema: unit-level (FR-2.5) ──────────────────────────────

test("googleLoginSchema: idToken hợp lệ pass", () => {
  assert.doesNotThrow(() => googleLoginSchema.body.parse({ idToken: "a-valid-token" }));
});

test("googleLoginSchema: thiếu idToken fail", () => {
  assert.throws(() => googleLoginSchema.body.parse({}), z.ZodError);
});

test("googleLoginSchema: idToken rỗng '' fail", () => {
  assert.throws(() => googleLoginSchema.body.parse({ idToken: "" }), z.ZodError);
});

test("googleLoginSchema: {idToken, email, name} -> email/name bị strip, chỉ còn idToken", () => {
  const parsed: any = googleLoginSchema.body.parse({
    idToken: "a-valid-token",
    email: "duc@example.com",
    name: "Duc",
    avatar: "https://example.com/a.png",
  });
  assert.deepEqual(parsed, { idToken: "a-valid-token" });
  assert.equal(parsed.email, undefined, "email do client gửi phải bị strip");
  assert.equal(parsed.name, undefined, "name do client gửi phải bị strip");
});

// ── 2) Route thật, qua validate() (FR-2.5) ─────────────────────────────────

test("FR-2.5: POST /users/sessions/google thiếu idToken -> 400, không tới controller (không phải 401/500 từ Google verify)", async () => {
  await withServer(mountUserRouter(), async (base) => {
    const res = await fetch(`${base}/users/sessions/google`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
  });
});

test("FR-2.5: POST /users/sessions/google với idToken: '' -> 400", async () => {
  await withServer(mountUserRouter(), async (base) => {
    const res = await fetch(`${base}/users/sessions/google`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken: "" }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
  });
});

test("hợp đồng với 012: route tồn tại đúng đường dẫn POST /users/sessions/google -> không phải 404", async () => {
  await withServer(mountUserRouter(), async (base) => {
    const res = await fetch(`${base}/users/sessions/google`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken: "garbage-not-a-real-google-token" }),
    });
    assert.notEqual(res.status, 404, "route phải được đăng ký, không rơi vào 404");
  });
});

// ── 3) Wiring nguồn: đúng middleware chain, đúng limiter (FR-12) ──────────

test("FR-12 (wiring): route GOOGLE_SESSION dùng authTierLimiter + validate(googleLoginSchema) + asyncHandler(googleLogin), không dùng protectRoute", async () => {
  const src = await readFile("src/api/routers/user.route.ts", "utf8");
  const code = src.replace(/^\s*\/\/.*$/gm, "");

  const startIdx = code.indexOf("router.post(\n  GOOGLE_SESSION,");
  assert.ok(startIdx !== -1, "phải tìm thấy route GOOGLE_SESSION");
  const endIdx = code.indexOf(");", startIdx);
  const block = code.slice(startIdx, endIdx);

  assert.ok(
    block.includes("authTierLimiter"),
    "GOOGLE_SESSION phải dùng authTierLimiter — cùng tier với LOGIN, không tự định nghĩa limiter riêng"
  );
  assert.ok(
    block.includes("validate(googleLoginSchema)"),
    "GOOGLE_SESSION phải validate bằng googleLoginSchema"
  );
  assert.ok(
    block.includes("asyncHandler(googleLogin)"),
    "GOOGLE_SESSION phải mount googleLogin (không phải googleLoginWith) qua asyncHandler"
  );
  assert.ok(
    !block.includes("protectRoute"),
    "GOOGLE_SESSION là endpoint đăng nhập — không được dùng protectRoute"
  );

  const idxLogin = code.indexOf("router.post(\n  LOGIN,");
  const idxLogout = code.indexOf("router.post(LOGOUT,");
  assert.ok(idxLogin >= 0 && idxLogout >= 0);
  assert.ok(
    idxLogin < startIdx && startIdx < idxLogout,
    "GOOGLE_SESSION phải đăng ký giữa LOGIN và LOGOUT, cùng nhóm session"
  );
});

test("FR-12 (wiring): USER_PATH.GOOGLE_SESSION = '/sessions/google'", async () => {
  const src = await readFile("src/Breads-Shared/APIConfig.ts", "utf8");
  assert.match(src, /static\s+GOOGLE_SESSION\s*=\s*"\/sessions\/google"/);
});

// ── 4) Rate-limit thật (FR-12) — chỉ chạy khi có Redis thật ───────────────

test(
  "FR-12: request thứ 6 tới /users/sessions/google trong window bị 429, giống POST /users/sessions",
  needsRedis,
  async () => {
    // authTierLimiter dùng authRedisStore, chỉ hoạt động (không fail-open) sau khi
    // initRedis() được gọi VÀ client sẵn sàng — giống setup trong rateLimitRedisStore.test.ts.
    initRedis();
    const redisClient = getRedisInstance();
    if (redisClient && redisClient.status !== "ready") {
      await once(redisClient, "ready");
    }
    // authRedisStore dùng một dedicated connection (base.duplicate()) riêng cho Lua
    // script — kết nối này mở lazy ở lần increment() đầu tiên và cần vài ms để sẵn
    // sàng. "Làm nóng" nó trước, nếu không request đầu của vòng lặp bên dưới sẽ bị
    // fail-open oan (giống warmup trong rateLimitRedisStore.test.ts).
    const warmupStore = createRedisSlidingWindowStore({ windowMs: 60_000, max: 5 });
    const warmupKey = `google-route-test-warmup:${Date.now()}`;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await warmupStore.increment(warmupKey);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await warmupStore.resetKey?.(warmupKey).catch(() => {});

    const seen = new Set<string>();
    const app = express();
    app.use(express.json());
    app.use(
      "/users",
      (req, _res, next) => {
        seen.add(ipKeyGenerator(req.ip ?? ""));
        next();
      },
      userRouter
    );
    app.use(errorHandler);

    try {
      await withServer(app, async (base) => {
        const body = JSON.stringify({ idToken: "garbage-not-a-real-google-token" });
        const headers = { "content-type": "application/json" };

        for (let i = 1; i <= 5; i++) {
          const res = await fetch(`${base}/users/sessions/google`, {
            method: "POST",
            headers,
            body,
          });
          assert.notEqual(
            res.status,
            429,
            `request ${i}/5 chưa được vượt ngưỡng, không được là 429`
          );
        }
        const sixth = await fetch(`${base}/users/sessions/google`, {
          method: "POST",
          headers,
          body,
        });
        assert.equal(sixth.status, 429, "request thứ 6 phải bị authTierLimiter chặn");
        assert.ok(sixth.headers.get("retry-after"), "429 phải kèm Retry-After");
      });
    } finally {
      for (const key of seen) {
        await authTierLimiter.resetKey(key).catch(() => {});
      }
    }
  }
);
