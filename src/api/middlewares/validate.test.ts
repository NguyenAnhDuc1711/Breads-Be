// Run with Node's built-in test runner: `npm test`.
//
// Phạm vi: Task 001 — `validate()` middleware, primitive dùng chung (`common.ts`), và fix bug
// `app.ts:50` (`err.status` -> `err.statusCode || err.status`).
//
// 2 tầng test, CỐ Ý không thay thế nhau được:
//  - Tầng mock (`next` giả): kiểm hành vi nội bộ của middleware — nhanh, không mở socket.
//  - Tầng HTTP (mount router TRẦN trên 1 `express()` mới, không import `app.ts`, không cần
//    Mongo/Redis): kiểm mã lỗi THẬT trả về client. Bắt buộc phải có tầng này — đúng loại bug
//    `app.ts:50` (BadRequestError trả 500 thay vì 400) KHÔNG thể phát hiện bằng test mock `next`,
//    đó chính là lý do nó lọt suốt từ trước tới nay. Pattern này (AD-7) các task Phase 2/3 tái dùng.
import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import express from "express";
import { z } from "zod";
import { validate, VALIDATION_ERROR_MESSAGE } from "./validate.ts";
import { objectIdSchema, paginationQuerySchema } from "../validators/common.ts";
import { BadRequestError } from "../../core/error.response.ts";
import logger from "../../core/logger.ts";

const VALID_OBJECT_ID = "652f1b2c3d4e5f6071829304";

// `validate()` log `logger.warn` mỗi lần payload sai — im lặng hoá để output test sạch.
const silenceWarn = async (fn: () => unknown | Promise<unknown>) => {
  const original = logger.warn;
  (logger as any).warn = () => {};
  try {
    return await fn();
  } finally {
    (logger as any).warn = original;
  }
};

const mockReq = (over: any = {}) => ({
  path: "/t",
  body: {},
  query: {},
  params: {},
  ...over,
});

// Global error handler dùng ĐÚNG logic đã fix ở `src/app.ts:50`.
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

/* ---------------------------------------------------------------- tầng mock */

test("FR-1: body hợp lệ -> next() không tham số, req.body là kết quả đã parse", () => {
  const req = mockReq({ body: { x: "hello" } });
  const calls: any[] = [];

  validate({ body: z.object({ x: z.string() }) })(req, {}, (...a) =>
    calls.push(a)
  );

  assert.deepEqual(calls, [[]], "next() phải được gọi đúng 1 lần, không có lỗi");
  assert.deepEqual(req.body, { x: "hello" });
});

test("FR-2: body sai -> next(BadRequestError) với message hằng, KHÔNG throw ra ngoài", async () => {
  const req = mockReq({ body: { x: 123 } });
  const calls: any[] = [];

  await silenceWarn(() =>
    validate({ body: z.object({ x: z.string() }) })(req, {}, (...a) =>
      calls.push(a)
    )
  );

  assert.equal(calls.length, 1);
  const [err] = calls[0];
  assert.ok(err instanceof BadRequestError);
  assert.equal(err.message, VALIDATION_ERROR_MESSAGE);
  assert.equal((err as any).statusCode, 400);
});

test("FR-2: body sai -> req.body KHÔNG bị ghi đè (giữ nguyên payload gốc)", async () => {
  const original = { x: 123 };
  const req = mockReq({ body: original });

  await silenceWarn(() =>
    validate({ body: z.object({ x: z.string() }) })(req, {}, () => {})
  );

  assert.equal(req.body, original, "cùng reference, không bị thay bằng kết quả parse dở dang");
  assert.deepEqual(req.body, { x: 123 });
});

test("FR-3: query string được coerce -> req.query.limit là number, không phải string", () => {
  const req = mockReq({ query: { limit: "20" } });

  validate({ query: z.object({ limit: z.coerce.number() }) })(req, {}, () => {});

  assert.equal(req.query.limit, 20);
  assert.equal(typeof req.query.limit, "number");
});

test("AD-6: params được gán lại bình thường (không phải getter readonly)", () => {
  const req = mockReq({ params: { id: VALID_OBJECT_ID } });

  validate({ params: z.object({ id: objectIdSchema }) })(req, {}, () => {});

  assert.deepEqual(req.params, { id: VALID_OBJECT_ID });
});

test("lỗi KHÔNG phải ZodError -> next(err) nguyên vẹn, không bị nuốt hay đổi thành 400", () => {
  const boom = new Error("boom");
  const calls: any[] = [];

  validate({ body: { parse: () => { throw boom; } } as any })(
    mockReq(),
    {},
    (...a) => calls.push(a)
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], boom);
});

/* ---------------------------------------------------------------- tầng HTTP */

test("FR-2 + NFR-3 (HTTP thật): payload sai -> 400 với message generic, response KHÔNG lộ chi tiết zod", async () => {
  const app = express();
  app.use(express.json());
  // Body dạng block (không phải arrow trả thẳng `res.json(...)`): `@types/express` v5 yêu cầu
  // handler trả `void`, arrow rút gọn sẽ trả `Response` và fail `tsc --noEmit`.
  app.post("/t", validate({ body: z.object({ x: z.string() }) }), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);

  await silenceWarn(() =>
    withServer(app, async (base) => {
      const res = await fetch(`${base}/t`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x: 123 }),
      });
      const raw = await res.text();

      assert.equal(res.status, 400, "phải là 400 THẬT — 500 nghĩa là bug app.ts:50 quay lại");
      assert.deepEqual(JSON.parse(raw), { message: VALIDATION_ERROR_MESSAGE });
      for (const leak of ["issues", "path", "code", "expected", "invalid_type", "x"]) {
        assert.ok(!raw.includes(leak), `response không được chứa chi tiết zod: "${leak}"`);
      }
    })
  );
});

test("FR-1 + FR-3 (HTTP thật): payload hợp lệ -> 200, controller nhận body/query/params đã coerce", async () => {
  const app = express();
  app.use(express.json());
  app.post(
    "/t/:id",
    validate({
      body: z.object({ x: z.string() }),
      query: z.object({ limit: z.coerce.number() }),
      params: z.object({ id: objectIdSchema }),
    }),
    (req, res) => {
      res.json({
        body: req.body,
        limitType: typeof req.query.limit,
        limit: req.query.limit,
        id: req.params.id,
      });
    }
  );
  app.use(errorHandler);

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/t/${VALID_OBJECT_ID}?limit=20`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x: "hello" }),
    });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      body: { x: "hello" },
      limitType: "number",
      limit: 20,
      id: VALID_OBJECT_ID,
    });
  });
});

test("fix app.ts:50 (HTTP thật): BadRequestType ném từ controller -> 400, KHÔNG phải 500", async () => {
  const app = express();
  app.get("/boom", () => {
    throw new BadRequestError("userId is required");
  });
  app.use(errorHandler);

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/boom`);
    assert.equal(
      res.status,
      400,
      "BadRequestError set .statusCode chứ không phải .status — handler phải đọc .statusCode trước"
    );
  });
});

test("fix app.ts:50: source thật của src/app.ts đọc err.statusCode trước err.status", async () => {
  // Đọc source thay vì `import app` — `app.ts` connect Mongo/Redis THẬT ngay lúc import (AD-7).
  // Đường dẫn theo cwd: `npm test` luôn chạy từ thư mục gốc repo.
  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile("src/app.ts", "utf8")
  );

  assert.ok(
    src.includes("err.statusCode || err.status || 500"),
    "src/app.ts phải giữ fix `err.statusCode || err.status || 500` (err.status vẫn cần cho handler 404)"
  );
});

/* --------------------------------------------------------- primitive chung */

test("FR-9: objectIdSchema nhận chuỗi ObjectId 24 ký tự hex hợp lệ", () => {
  assert.equal(objectIdSchema.parse(VALID_OBJECT_ID), VALID_OBJECT_ID);
});

test("FR-9: objectIdSchema từ chối chuỗi không phải ObjectId", () => {
  for (const bad of ["not-an-id", "123", "", "$where:1", "652f1b2c3d4e5f607182930"]) {
    assert.throws(
      () => objectIdSchema.parse(bad),
      z.ZodError,
      `phải từ chối ${JSON.stringify(bad)}`
    );
  }
});

test("paginationQuerySchema: coerce string (đúng cách Express giao query) thành number", () => {
  assert.deepEqual(paginationQuerySchema.parse({ page: "2", limit: "10" }), {
    page: 2,
    limit: 10,
  });
});

test("AD-3: paginationQuerySchema KHÔNG cap limit — limit lớn vẫn hợp lệ (không đổi hành vi sẵn có)", () => {
  assert.deepEqual(paginationQuerySchema.parse({ limit: "1000" }), { limit: 1000 });
  assert.deepEqual(paginationQuerySchema.parse({}), {});
});

test("paginationQuerySchema từ chối page/limit không hợp lệ (0, âm, không phải số)", () => {
  for (const bad of [{ page: "0" }, { limit: "-1" }, { page: "abc" }, { limit: "1.5" }]) {
    assert.throws(() => paginationQuerySchema.parse(bad), z.ZodError);
  }
});
