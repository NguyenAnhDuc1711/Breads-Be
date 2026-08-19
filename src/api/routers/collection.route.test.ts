// Run with Node's built-in test runner: `npm test`.
//
// Phạm vi: Task 014 — 3 schema của router `collection`; cập nhật ở task 013 (redesign RESTful):
// ADD -> PATCH /:userId/items (userId path, postId body), REMOVE -> DELETE /:userId/items/:postId
// (cả 2 id path, không còn body).
//
// Pattern (task 001, AD-7): mount `validate(schema)` trần trên 1 `express()` mới, không import
// `app.ts`/`collection.route.ts` thật — không cần Mongo/Redis, vẫn kiểm đúng mã lỗi HTTP THẬT.
// Riêng test 404 (deletedCount===0) gọi thẳng controller với model stub (pattern
// `notification.route.test.ts`), vì đây là logic điều khiển ở controller, không phải schema.
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
import { removePostFromCollection } from "../controllers/collection.controller.ts";
import SavedPost from "../models/savedPost.model.ts";
import { NotFoundError } from "../../core/error.response.ts";
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

// Task 013 (D-1): PATCH /:userId/items — userId trong path, postId trong body.
const makeAddApp = (schema, echo = false) => {
  const app = express();
  app.use(express.json());
  app.patch("/t/:userId/items", validate(schema), (req, res) => {
    res.json(echo ? { params: req.params, body: req.body } : { ok: true });
  });
  app.use(errorHandler);
  return app;
};

// Task 013 (D-1): DELETE /:userId/items/:postId — cả 2 id trong path, không còn body.
const makeRemoveApp = (schema) => {
  const app = express();
  app.use(express.json());
  app.delete("/t/:userId/items/:postId", validate(schema), (req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
};

const patchAdd = (base: string, userId: string, body: unknown) =>
  fetch(`${base}/t/${userId}/items`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const deleteRemove = (base: string, userId: string, postId: string) =>
  fetch(`${base}/t/${userId}/items/${postId}`, { method: "DELETE" });

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

/* ------------------------------------------- addPostToCollectionSchema (params + body) */

test("Task 013: addPostToCollectionSchema: userId (path) + postId (body) hợp lệ -> 200", async () => {
  await withServer(makeAddApp(addPostToCollectionSchema, true), async (base) => {
    const res = await patchAdd(base, VALID_ID_1, { postId: VALID_ID_2 });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      params: { userId: VALID_ID_1 },
      body: { postId: VALID_ID_2 },
    });
  });
});

test("FR-7: addPostToCollectionSchema: thiếu postId trong body -> 400", async () => {
  await silenceWarn(() =>
    withServer(makeAddApp(addPostToCollectionSchema), async (base) => {
      const res = await patchAdd(base, VALID_ID_1, {});
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

test("Task 013: addPostToCollectionSchema: userId (path) không phải ObjectId -> 400", async () => {
  await silenceWarn(() =>
    withServer(makeAddApp(addPostToCollectionSchema), async (base) => {
      const res = await patchAdd(base, "not-an-objectid", { postId: VALID_ID_2 });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

/* -------------------------------------------- removePostFromCollectionSchema (params only) */

test("Task 013: removePostFromCollectionSchema: userId + postId (path) hợp lệ -> 200", async () => {
  await withServer(makeRemoveApp(removePostFromCollectionSchema), async (base) => {
    const res = await deleteRemove(base, VALID_ID_1, VALID_ID_2);
    assert.equal(res.status, 200);
  });
});

test("Task 013: removePostFromCollectionSchema: userId (path) không phải ObjectId -> 400", async () => {
  await silenceWarn(() =>
    withServer(makeRemoveApp(removePostFromCollectionSchema), async (base) => {
      const res = await deleteRemove(base, "not-an-objectid", VALID_ID_2);
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

test("removePostFromCollectionSchema: postId (path) không phải ObjectId -> 400", async () => {
  await silenceWarn(() =>
    withServer(makeRemoveApp(removePostFromCollectionSchema), async (base) => {
      const res = await deleteRemove(base, VALID_ID_1, "abc");
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

/* --------------------------------------- removePostFromCollection controller (plan-review edge case) */

const fakeRes = () => {
  const res: any = {};
  res.statusCode = undefined;
  res.body = undefined;
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload: any) => {
    res.body = payload;
    return res;
  };
  return res;
};

test("Task 013 (plan-review edge case): postId không tồn tại trong collection -> NotFoundError (404)", async () => {
  const original = (SavedPost as any).deleteOne;
  (SavedPost as any).deleteOne = async () => ({ deletedCount: 0 });
  try {
    const req: any = { params: { userId: VALID_ID_1, postId: VALID_ID_2 } };
    const res = fakeRes();
    await assert.rejects(
      () => removePostFromCollection(req, res),
      (err: any) => err instanceof NotFoundError && err.statusCode === 404
    );
  } finally {
    (SavedPost as any).deleteOne = original;
  }
});

/* --------------------------------------------------------------- wiring/structure */

test("collection.route.ts: validate() wired vào đúng 3 route", async () => {
  const src = await fs.readFile("src/api/routers/collection.route.ts", "utf8");
  const validateCalls = src.match(/validate\(/g) || [];
  assert.equal(validateCalls.length, 3, "phải có đúng 3 lần gọi validate(...)");
});
