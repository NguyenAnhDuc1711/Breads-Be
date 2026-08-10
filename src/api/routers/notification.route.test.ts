// Run with Node's built-in test runner: `npm test`.
//
// Phạm vi: Task 014 — schema của router `notification` (1 route).
//
// Pattern (task 001, AD-7): mount `validate(schema)` trần trên 1 `express()` mới, không import
// `app.ts`/`notification.route.ts` thật — không cần Mongo/Redis, vẫn kiểm đúng mã lỗi HTTP THẬT.
import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import express from "express";
import fs from "node:fs/promises";
import { validate, VALIDATION_ERROR_MESSAGE } from "../middlewares/validate.ts";
import { getNotificationsSchema } from "../validators/notification.validator.ts";
import logger from "../../core/logger.ts";

const VALID_ID = "652f1b2c3d4e5f6071829304";

const silenceWarn = async (fn: () => unknown | Promise<unknown>) => {
  const original = logger.warn;
  (logger as any).warn = () => {};
  try {
    return await fn();
  } finally {
    (logger as any).warn = original;
  }
};

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

const makeApp = (echo = false) => {
  const app = express();
  app.use(express.json());
  app.post("/t", validate(getNotificationsSchema), (req, res) => {
    res.json(echo ? { body: req.body } : { ok: true });
  });
  app.use(errorHandler);
  return app;
};

/* ------------------------------------------------ getNotificationsSchema (body) */

test("getNotificationsSchema: body hợp lệ -> 200", async () => {
  await withServer(makeApp(true), async (base) => {
    const res = await fetch(`${base}/t`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: VALID_ID, page: 1, limit: 10 }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      body: { userId: VALID_ID, page: 1, limit: 10 },
    });
  });
});

test("FR-7: getNotificationsSchema: thiếu userId -> 400", async () => {
  await silenceWarn(() =>
    withServer(makeApp(), async (base) => {
      const res = await fetch(`${base}/t`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ page: 1, limit: 10 }),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

test("getNotificationsSchema: userId không phải ObjectId -> 400", async () => {
  await silenceWarn(() =>
    withServer(makeApp(), async (base) => {
      const res = await fetch(`${base}/t`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "not-an-id", page: 1, limit: 10 }),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

// AD-5: field body KHÔNG được coerce. Đây là nửa còn lại của cặp kiểm chứng query-vs-body
// (nửa kia ở `report.route.test.ts` với `getReportsSchema`).
test("AD-5: getNotificationsSchema: page là string JSON \"2\" -> 400 (body không coerce)", async () => {
  await silenceWarn(() =>
    withServer(makeApp(), async (base) => {
      const res = await fetch(`${base}/t`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: VALID_ID, page: "2", limit: 10 }),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

/* --------------------------------------------------------------- wiring/structure */

test("notification.route.ts: validate() wired vào đúng 1 route", async () => {
  const src = await fs.readFile("src/api/routers/notification.route.ts", "utf8");
  const validateCalls = src.match(/validate\(/g) || [];
  assert.equal(validateCalls.length, 1, "phải có đúng 1 lần gọi validate(...)");
});
