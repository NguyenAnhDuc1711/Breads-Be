// Run with Node's built-in test runner: `npm test`.
//
// Phạm vi: Task 014 — 3 schema của router `collection`.
//
// Pattern (task 001, AD-7): mount `validate(schema)` trần trên 1 `express()` mới, không import
// `app.ts`/`collection.route.ts` thật — không cần Mongo/Redis, vẫn kiểm đúng mã lỗi HTTP THẬT.
import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import express from "express";
import fs from "node:fs/promises";
import { validate, VALIDATION_ERROR_MESSAGE } from "../middlewares/validate.ts";
import {
  addPostToCollectionSchema,
  getUserCollectionSchema,
  removePostFromCollectionSchema,
} from "../validators/collection.validator.ts";
import logger from "../../core/logger.ts";

const VALID_ID_1 = "652f1b2c3d4e5f6071829304";
const VALID_ID_2 = "652f1b2c3d4e5f6071829305";

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

const makeBodyApp = (schema, echo = false) => {
  const app = express();
  app.use(express.json());
  app.patch("/t", validate(schema), (req, res) => {
    res.json(echo ? { body: req.body } : { ok: true });
  });
  app.use(errorHandler);
  return app;
};

const postBody = (base: string, body: unknown) =>
  fetch(`${base}/t`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/* --------------------------------------------------- getUserCollectionSchema (params) */

test("FR-7: getUserCollectionSchema: userId param không phải ObjectId -> 400", async () => {
  const app = express();
  app.get("/collection/:userId", validate(getUserCollectionSchema), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);

  await silenceWarn(() =>
    withServer(app, async (base) => {
      const res = await fetch(`${base}/collection/not-an-objectid`);
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

test("getUserCollectionSchema: userId param hợp lệ -> 200", async () => {
  const app = express();
  app.get("/collection/:userId", validate(getUserCollectionSchema), (req, res) => {
    res.json({ params: req.params });
  });
  app.use(errorHandler);

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/collection/${VALID_ID_1}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { params: { userId: VALID_ID_1 } });
  });
});

/* ------------------------------------------------- addPostToCollectionSchema (body) */

test("addPostToCollectionSchema: body hợp lệ -> 200", async () => {
  await withServer(makeBodyApp(addPostToCollectionSchema, true), async (base) => {
    const res = await postBody(base, { userId: VALID_ID_1, postId: VALID_ID_2 });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      body: { userId: VALID_ID_1, postId: VALID_ID_2 },
    });
  });
});

test("FR-7: addPostToCollectionSchema: thiếu postId -> 400", async () => {
  await silenceWarn(() =>
    withServer(makeBodyApp(addPostToCollectionSchema), async (base) => {
      const res = await postBody(base, { userId: VALID_ID_1 });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

/* -------------------------------------------- removePostFromCollectionSchema (body) */

test("FR-7: removePostFromCollectionSchema: thiếu userId -> 400", async () => {
  await silenceWarn(() =>
    withServer(makeBodyApp(removePostFromCollectionSchema), async (base) => {
      const res = await postBody(base, { postId: VALID_ID_2 });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

test("removePostFromCollectionSchema: postId không phải ObjectId -> 400", async () => {
  await silenceWarn(() =>
    withServer(makeBodyApp(removePostFromCollectionSchema), async (base) => {
      const res = await postBody(base, { userId: VALID_ID_1, postId: "abc" });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

/* --------------------------------------------------------------- wiring/structure */

test("collection.route.ts: validate() wired vào đúng 3 route", async () => {
  const src = await fs.readFile("src/api/routers/collection.route.ts", "utf8");
  const validateCalls = src.match(/validate\(/g) || [];
  assert.equal(validateCalls.length, 3, "phải có đúng 3 lần gọi validate(...)");
});
