// Run with Node's built-in test runner: `npm test`.
//
// Phạm vi: Task 001 (security-hardening, FR-4) — error handler cuối `src/app.ts` ẩn `err.message`
// gốc cho lỗi KHÔNG thuộc nhóm "đã biết an toàn" khi `NODE_ENV !== "dev"`.
//
// KHÔNG import `src/app.ts` trực tiếp — file đó connect Mongo/Redis thật ngay lúc import (AD-7,
// xem `validate.test.ts`/`post.route.test.ts`). Thay vào đó: mirror ĐÚNG logic error handler thật
// (cùng import `ErrorResponse`/`STATUS_CODES`) lên 1 `express()` mới để test hành vi HTTP thật, và
// thêm 1 test đọc source `src/app.ts` để xác nhận app.ts thật giữ đúng logic đã mirror (chống drift).
import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { STATUS_CODES } from "node:http";
import express from "express";
import {
  BadRequestError,
  ErrorResponse,
  NotFoundError,
} from "../../core/error.response.ts";
import { validate, VALIDATION_ERROR_MESSAGE } from "./validate.ts";
import { z } from "zod";
import logger from "../../core/logger.ts";

const silenceWarn = async (fn: () => unknown | Promise<unknown>) => {
  const original = logger.warn;
  (logger as any).warn = () => {};
  try {
    return await fn();
  } finally {
    (logger as any).warn = original;
  }
};

/** Mirror ĐÚNG logic error handler cuối `src/app.ts` (dòng ~50-75). `isDevEnv` nhận qua tham số
 * thay vì đọc `process.env.NODE_ENV` trực tiếp — cho phép test nhiều env trong cùng 1 lần chạy mà
 * không phải mutate biến process global giữa các test song song. */
const makeErrorHandler = (isDevEnv: boolean) => (err, _req, res, _next) => {
  const statusCode = err.statusCode || err.status || 500;
  const isKnownBusinessError = err instanceof ErrorResponse;
  const message =
    isDevEnv || isKnownBusinessError
      ? err.message || "Internal Server Error"
      : STATUS_CODES[statusCode] || "Internal Server Error";

  const response: any = { status: "error", code: statusCode, message };
  if (isDevEnv) {
    response.stack = err.stack;
  }
  res.status(statusCode).json(response);
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

/* --------------------------------------------------------------- mock next() (nhanh) */

test("FR-4: lỗi KHÔNG thuộc ErrorResponse + isDevEnv=false -> message generic theo statusCode", () => {
  const handler = makeErrorHandler(false);
  const err = new Error("Mongoose validation failed: field xyz duplicate key E11000");
  (err as any).statusCode = 404;
  let captured: any;
  const res = {
    status(code: number) {
      captured = { code };
      return this;
    },
    json(body: any) {
      captured.body = body;
    },
  };

  handler(err, {}, res, () => {});

  assert.equal(captured.code, 404);
  assert.equal(captured.body.message, STATUS_CODES[404]);
  assert.notEqual(captured.body.message, err.message);
  assert.ok(!("stack" in captured.body));
});

test("FR-4: lỗi KHÔNG thuộc ErrorResponse + isDevEnv=false + statusCode 500 -> \"Internal Server Error\"", () => {
  const handler = makeErrorHandler(false);
  const err = new Error("connect ECONNREFUSED 127.0.0.1:27017");
  let captured: any;
  const res = {
    status(code: number) {
      captured = { code };
      return this;
    },
    json(body: any) {
      captured.body = body;
    },
  };

  handler(err, {}, res, () => {});

  assert.equal(captured.code, 500);
  assert.equal(captured.body.message, "Internal Server Error");
});

test("FR-4: BadRequestError (ErrorResponse) + isDevEnv=false -> vẫn giữ message gốc", () => {
  const handler = makeErrorHandler(false);
  const err = new BadRequestError("userId is required");
  let captured: any;
  const res = {
    status(code: number) {
      captured = { code };
      return this;
    },
    json(body: any) {
      captured.body = body;
    },
  };

  handler(err, {}, res, () => {});

  assert.equal(captured.code, 400);
  assert.equal(captured.body.message, "userId is required");
});

test("FR-4: isDevEnv=true -> luôn giữ message gốc + có stack, bất kể loại lỗi", () => {
  const handler = makeErrorHandler(true);
  const err = new Error("some internal db detail leaking on purpose for this test");
  let captured: any;
  const res = {
    status(code: number) {
      captured = { code };
      return this;
    },
    json(body: any) {
      captured.body = body;
    },
  };

  handler(err, {}, res, () => {});

  assert.equal(captured.body.message, err.message);
  assert.equal(captured.body.stack, err.stack);
});

/* --------------------------------------------------------------------- HTTP thật */

test("FR-4 (HTTP thật): NODE_ENV != dev, lỗi generic throw trong handler -> response message KHÔNG chứa chuỗi gốc", async () => {
  const app = express();
  app.get("/boom", () => {
    throw new Error("some internal db detail: users.email_1 dup key");
  });
  app.use(makeErrorHandler(false));

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/boom`);
    const body: any = await res.json();

    assert.equal(res.status, 500);
    assert.equal(body.message, "Internal Server Error");
    assert.ok(!JSON.stringify(body).includes("dup key"));
    assert.ok(!("stack" in body));
  });
});

test("FR-4 (HTTP thật): NODE_ENV != dev, BadRequestError throw trong handler -> response vẫn có message gốc", async () => {
  const app = express();
  app.get("/boom", () => {
    throw new BadRequestError("Email đã tồn tại");
  });
  app.use(makeErrorHandler(false));

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/boom`);
    const body: any = await res.json();

    assert.equal(res.status, 400);
    assert.equal(body.message, "Email đã tồn tại");
  });
});

test("FR-4 (HTTP thật): NODE_ENV != dev, lỗi từ validate() middleware -> response vẫn có VALIDATION_ERROR_MESSAGE (không bị generic hoá thêm lần nữa)", async () => {
  const app = express();
  app.use(express.json());
  app.post(
    "/t",
    validate({ body: z.object({ x: z.string() }) }),
    (_req, res) => {
      res.json({ ok: true });
    }
  );
  app.use(makeErrorHandler(false));

  await silenceWarn(() =>
    withServer(app, async (base) => {
      const res = await fetch(`${base}/t`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x: 123 }),
      });
      const body: any = await res.json();

      assert.equal(res.status, 400);
      assert.equal(body.message, VALIDATION_ERROR_MESSAGE);
    })
  );
});

test("FR-4 (HTTP thật): NotFoundError (ErrorResponse) không thuộc dev env -> vẫn giữ message gốc, không rơi về STATUS_CODES[404] mặc định", async () => {
  const app = express();
  app.get("/missing", () => {
    throw new NotFoundError("Post không tồn tại");
  });
  app.use(makeErrorHandler(false));

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/missing`);
    const body: any = await res.json();

    assert.equal(res.status, 404);
    assert.equal(body.message, "Post không tồn tại");
  });
});

/* ---------------------------------------------------- source assertion (chống drift, AD-7) */

test("src/app.ts (source thật) giữ đúng logic FR-4: instanceof ErrorResponse + STATUS_CODES[statusCode] fallback", async () => {
  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile("src/app.ts", "utf8")
  );

  assert.ok(
    src.includes("err instanceof ErrorResponse"),
    "phải nhận diện lỗi nghiệp vụ đã biết qua instanceof ErrorResponse"
  );
  assert.ok(
    src.includes("STATUS_CODES[statusCode]"),
    "phải dùng node:http STATUS_CODES làm message generic theo statusCode"
  );
  assert.ok(
    src.includes('import { STATUS_CODES } from "node:http";'),
    "phải import STATUS_CODES từ node:http"
  );
  assert.ok(
    src.includes('import { ErrorResponse } from "./core/error.response.ts";'),
    "phải import ErrorResponse từ core/error.response.ts"
  );
  assert.ok(
    /\(req\.log \|\| logger\)\.error\(\{ err, statusCode \}/.test(src),
    "log server phải luôn ghi đầy đủ err/statusCode bất kể env (FR-4)"
  );
});
