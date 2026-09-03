import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import express from "express";
import fs from "node:fs/promises";
import { validate, VALIDATION_ERROR_MESSAGE } from "../middlewares/validate.ts";
import {
  getReportsSchema,
  rejectReportSchema,
  responseReportSchema,
  sendReportSchema,
} from "../validators/report.validator.ts";
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
  app.post("/t", validate(schema), (req, res) => {
    res.json(echo ? { body: req.body } : { ok: true });
  });
  app.use(errorHandler);
  return app;
};

const postBody = (base: string, body: unknown) =>
  fetch(`${base}/t`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const makeQueryApp = (schema) => {
  const app = express();
  app.get("/t", validate(schema), (req, res) => {
    res.json({ query: req.query });
  });
  app.use(errorHandler);
  return app;
};

const makePatchIdApp = (schema, echo = false) => {
  const app = express();
  app.use(express.json());
  app.patch("/t/:id", validate(schema), (req, res) => {
    res.json(echo ? { params: req.params, body: req.body } : { ok: true });
  });
  app.use(errorHandler);
  return app;
};

const patchWithId = (base: string, id: string, body: unknown) =>
  fetch(`${base}/t/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("AD-5: getReportsSchema: page query string \"2\" -> coerce thành number 2", async () => {
  await withServer(makeQueryApp(getReportsSchema), async (base) => {
    const res = await fetch(`${base}/t?userId=${VALID_ID_1}&page=2`);
    assert.equal(res.status, 200);
    const { query } = (await res.json()) as { query: { page: unknown } };
    assert.equal(query.page, 2);
    assert.equal(typeof query.page, "number");
  });
});

test("Bước 10: getReportsSchema không còn nhận userId — vắng thì pass, gửi kèm thì bị strip", async () => {
  await withServer(makeQueryApp(getReportsSchema), async (base) => {
    const noUser = await fetch(`${base}/t?page=2`);
    assert.equal(noUser.status, 200);

    const withUser = await fetch(`${base}/t?userId=${VALID_ID_1}&page=2`);
    assert.equal(withUser.status, 200);
    const { query } = (await withUser.json()) as { query: Record<string, unknown> };
    assert.equal(query.userId, undefined, "userId client gửi phải bị strip");
  });
});

test("getReportsSchema: page/limit vắng mặt vẫn pass (optional)", async () => {
  await withServer(makeQueryApp(getReportsSchema), async (base) => {
    const res = await fetch(`${base}/t?userId=${VALID_ID_1}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { query: {} }, "userId bị strip (bước 10)");
  });
});

test("Bước 9: sendReportSchema không còn nhận userId — body rỗng pass, userId gửi kèm bị strip", async () => {
  await withServer(makeBodyApp(sendReportSchema, true), async (base) => {
    const res = await postBody(base, { userId: VALID_ID_1, content: "spam" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { body: { content: "spam" } });
  });
});


const validResponseBody = {
  subject: "Về báo cáo của bạn",
  html: "<p>hi</p>",
  userId: VALID_ID_1,
};

test("Task 014: responseReportSchema: id (path) + body đầy đủ hợp lệ -> 200", async () => {
  await withServer(makePatchIdApp(responseReportSchema, true), async (base) => {
    const res = await patchWithId(base, VALID_ID_2, validResponseBody);
    assert.equal(res.status, 200);
    const { userId: _stripped, ...expectedBody } = validResponseBody as any;
    assert.deepEqual(await res.json(), {
      params: { id: VALID_ID_2 },
      body: expectedBody,
    });
  });
});

test("Task 014: responseReportSchema: id (path) không phải ObjectId -> 400", async () => {
  await silenceWarn(() =>
    withServer(makePatchIdApp(responseReportSchema), async (base) => {
      const res = await patchWithId(base, "not-an-objectid", validResponseBody);
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});


test("responseReportSchema: subject rỗng -> 400", async () => {
  await silenceWarn(() =>
    withServer(makePatchIdApp(responseReportSchema), async (base) => {
      const res = await patchWithId(base, VALID_ID_2, { ...validResponseBody, subject: "" });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

test("FR-7: rejectReportSchema: id (path) không phải ObjectId -> 400", async () => {
  await silenceWarn(() =>
    withServer(makePatchIdApp(rejectReportSchema), async (base) => {
      const res = await patchWithId(base, "not-an-objectid", { userId: VALID_ID_1 });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

test("Bước 10: rejectReportSchema: id (path) hợp lệ -> 200, userId gửi kèm bị strip", async () => {
  await withServer(makePatchIdApp(rejectReportSchema, true), async (base) => {
    const res = await patchWithId(base, VALID_ID_2, { userId: VALID_ID_1 });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      params: { id: VALID_ID_2 },
      body: {},
    });
  });
});

test("report.route.ts: validate() wired vào đúng 5 route", async () => {
  const src = await fs.readFile("src/api/routers/report.route.ts", "utf8");
  const validateCalls = src.match(/validate\(/g) || [];
  assert.equal(
    validateCalls.length,
    5,
    "phải có đúng 5 lần gọi validate(...) (4 gốc + GET_BY_USER, Users module)"
  );
});

test("report.route.ts: validate() đứng sau protectRoute ở REPORT_PATH.CREATE", async () => {
  const src = await fs.readFile("src/api/routers/report.route.ts", "utf8");
  const createCall = src.slice(src.indexOf("REPORT_PATH.CREATE"));
  const block = createCall.slice(0, createCall.indexOf("REPORT_PATH.RESPONSE"));
  assert.ok(block.length > 0, "không tìm thấy block route CREATE");
  assert.ok(
    block.indexOf("protectRoute") < block.indexOf("validate("),
    "protectRoute phải chạy trước validate()"
  );
});
