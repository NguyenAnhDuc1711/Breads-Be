// Run with Node's built-in test runner: `npm test`.
//
// Phạm vi: Task 015 — schema cho `analytics.route.ts` (FR-8).
//
// Pattern (task 001, AD-7): mount schema + `validate()` THẬT trên 1 `express()` mới, không import
// `analytics.route.ts` thật (route thật cần Mongo cho `AnalyticsModel`). `GET` (route `getEvents`)
// cố ý không có schema — handler không đọc field nào từ `req.body` (comment out ở
// `analytics.controller.ts:47`) nên không có gì để validate.
import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import fsp from "node:fs/promises";
import express from "express";
import { validate, VALIDATION_ERROR_MESSAGE } from "../middlewares/validate.ts";
import { createEventSchema } from "../validators/analytics.validator.ts";
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

/* --------------------------------------------- createEventSchema */

test("createEventSchema: thiếu event -> 400", async () => {
  const app = express();
  app.use(express.json());
  app.post("/t", validate(createEventSchema), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);

  await silenceWarn(() =>
    withServer(app, async (base) => {
      const res = await fetch(`${base}/t`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: VALID_ID }),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

test("createEventSchema: payload là object bất kỳ -> 200 (z.any())", async () => {
  const app = express();
  app.use(express.json());
  app.post("/t", validate(createEventSchema), (req, res) => {
    res.json({ body: req.body });
  });
  app.use(errorHandler);

  const payload = {
    userId: VALID_ID,
    event: "click",
    payload: { nested: { arbitrary: true }, count: 3 },
  };

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/t`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { body: payload });
  });
});

/* ------------------------------------------------- wiring (đọc source, không import) */

test("wiring: analytics.route.ts có đúng 1 validate(), chỉ trên route CREATE", async () => {
  const src = await fsp.readFile("src/api/routers/analytics.route.ts", "utf8");

  const routeLines = src
    .split("\n")
    .join(" ")
    .match(/router\.(get|post|put|delete)\([\s\S]*?\);/g);

  assert.ok(routeLines, "không parse được route nào từ analytics.route.ts");
  assert.equal(routeLines.length, 2, "analytics.route.ts phải có đúng 2 route");

  const withValidate = routeLines.filter((line) => line.includes("validate("));
  assert.equal(withValidate.length, 1, "đúng 1 route (CREATE) phải có validate()");

  const getLine = routeLines.find((line) => line.includes("GET"));
  assert.ok(getLine, "phải tìm thấy route GET");
  assert.ok(
    !getLine.includes("validate("),
    "GET (getEvents) cố ý không có validate() — handler không đọc field nào từ body"
  );
});
