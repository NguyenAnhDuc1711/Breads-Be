// Run with Node's built-in test runner: `npm test`.
//
// Phạm vi: Task 014 — schema của router `notification`; + task 001 của epic notification-fixes
// (FR-1 auth guard, FR-6 filter `action`, FR-3 field `isRead` trong `$project`).
//
// Hai pattern song song trong file này:
//  1. (task 014, AD-7) mount `validate(schema)` TRẦN trên 1 `express()` mới — kiểm mã lỗi HTTP thật
//     của tầng schema, không cần Mongo/Redis.
//  2. (task 001 epic notification-fixes, TEST-5) import ROUTER THẬT + `cookieParser` + `jwt.sign` +
//     stub `User.findById().select()` và `Notification.aggregate` — cách duy nhất chạm được nhánh
//     "đã đăng nhập" và quan sát pipeline thực sự gửi xuống Mongo. Stub gán đè PROPERTY của object
//     đã import rồi restore trong `finally` (pattern `post.route.test.ts:249-267`).
//
// ⚠️ TEST-4: mọi assert về `$match`/`$project` phải nằm trên OBJECT TRUYỀN VÀO stub, không phải trên
// giá trị stub trả về — `aggregate` bị stub thì pipeline không bao giờ được MongoDB thực thi.
import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import fs from "node:fs/promises";
import { validate, VALIDATION_ERROR_MESSAGE } from "../middlewares/validate.ts";
import { getNotificationsSchema } from "../validators/notification.validator.ts";
import notificationRouter from "./notification.route.ts";
import Notification from "../models/notification.model.ts";
import User from "../models/user.model.ts";
import logger from "../../core/logger.ts";

const VALID_ID = "652f1b2c3d4e5f6071829304";
const USER_X = "652f1b2c3d4e5f6071829305";
const USER_Y = "652f1b2c3d4e5f6071829306";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const silenceWarn = async (fn: () => unknown | Promise<unknown>) => {
  const original = logger.warn;
  (logger as any).warn = () => {};
  try {
    return await fn();
  } finally {
    (logger as any).warn = original;
  }
};

const silenceError = async (fn: () => unknown | Promise<unknown>) => {
  const original = logger.error;
  (logger as any).error = () => {};
  try {
    return await fn();
  } finally {
    (logger as any).error = original;
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

/* ------------------------------------------- harness router THẬT (TEST-5, task 001 epic) */

const makeRouterApp = () => {
  const app = express();
  // `protectRoute.ts:12-13` đọc `req.cookies?.jwt`.
  app.use(cookieParser());
  app.use("/api/notifications", notificationRouter);
  app.use(errorHandler);
  return app;
};

// Stub `User.findById(...).select(...)` — không stub thì Mongoose buffer 10s rồi timeout vì test
// không có connection. `lastActiveAt` mới tinh để `protectRoute` không gọi `User.updateOne`.
const stubUser = (userId: string) => {
  const original = (User as any).findById;
  (User as any).findById = () => ({
    select: async () => ({ _id: userId, lastActiveAt: new Date() }),
  });
  return () => {
    (User as any).findById = original;
  };
};

const stubAggregate = () => {
  const original = (Notification as any).aggregate;
  const pipelines: any[] = [];
  (Notification as any).aggregate = async (pipeline) => {
    pipelines.push(pipeline);
    return [];
  };
  return {
    pipelines,
    get calls() {
      return pipelines.length;
    },
    restore: () => {
      (Notification as any).aggregate = original;
    },
  };
};

const stageIndex = (pipeline: any[], name: string) =>
  pipeline.findIndex((s) => Object.keys(s)[0] === name);

const stageOf = (pipeline: any[], name: string) => {
  const idx = stageIndex(pipeline, name);
  assert.notEqual(idx, -1, `pipeline phải có stage ${name}`);
  return pipeline[idx][name];
};

const tokenFor = (userId: string) =>
  jwt.sign({ userId }, process.env.JWT_SECRET as string);

// Gửi 1 request POST /api/notifications/get qua router THẬT với stub sẵn.
const postGet = async (
  { userId, cookie, body }: { userId?: string; cookie?: string; body: any },
  assertFn: (ctx: { res: any; agg: ReturnType<typeof stubAggregate> }) => void | Promise<void>
) => {
  const restoreUser = stubUser(userId ?? USER_X);
  const agg = stubAggregate();
  try {
    await withServer(makeRouterApp(), async (base) => {
      const res = await fetch(`${base}/api/notifications/get`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
      });
      await assertFn({ res: res as any, agg });
    });
  } finally {
    agg.restore();
    restoreUser();
  }
};

/* ------------------------------------------------ getNotificationsSchema (body) */

test("getNotificationsSchema: body hợp lệ -> 200", async () => {
  await withServer(makeApp(true), async (base) => {
    const res = await fetch(`${base}/t`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ page: 1, limit: 10 }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { body: { page: 1, limit: 10 } });
  });
});

// FR-1: `userId` đã bị XOÁ khỏi schema — body không có nó nay là hợp đồng ĐÚNG, không còn là 400.
// (Test này trước đây mang tiền tố FR-7 của epic security-hardening — TRÙNG SỐ với FR-7 của epic
// này; đã đổi tên để cách verify SC-11 bằng grep tiền tố `FR-<n>` của task 090 không đếm nhầm.)
test("getNotificationsSchema: không có userId -> 200 (userId đã rời schema)", async () => {
  await withServer(makeApp(true), async (base) => {
    const res = await fetch(`${base}/t`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ page: 1, limit: 10 }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { body: { page: 1, limit: 10 } });
  });
});

// NFR-1 (backward compat): FE cũ chưa deploy vẫn gửi `userId`. `z.object()` STRIP key không khai
// báo -> 200, và key biến mất khỏi `req.body` trước khi tới controller. Đây là bằng chứng cho lựa
// chọn "xoá key khỏi schema" thay vì "đối chiếu với req.user._id" (AD-2/R-2).
test("FR-1: body thừa userId -> 200 và userId bị strip khỏi req.body", async () => {
  await withServer(makeApp(true), async (base) => {
    const res = await fetch(`${base}/t`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: VALID_ID, page: 1, limit: 10 }),
    });
    assert.equal(res.status, 200);
    const payload: any = await res.json();
    assert.deepEqual(payload, { body: { page: 1, limit: 10 } });
    assert.ok(
      !("userId" in payload.body),
      "userId phải bị strip, không được đi tiếp vào controller"
    );
  });
});

// AD-5: field body KHÔNG được coerce. Đây là nửa còn lại của cặp kiểm chứng query-vs-body
// (nửa kia ở `report.route.test.ts` với `getReportsSchema`).
test("AD-5: getNotificationsSchema: page là string JSON \"2\" -> 400 (body không coerce)", async () => {
  await silenceWarn(() =>
    withServer(makeApp(), async (base) => {
      const res = await fetch(`${base}/t`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ page: "2", limit: 10 }),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

test("FR-1: thiếu page -> 400 (page/limit vẫn bắt buộc sau khi bỏ userId)", async () => {
  await silenceWarn(() =>
    withServer(makeApp(), async (base) => {
      const res = await fetch(`${base}/t`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 10 }),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

test("FR-6: action='khong-ton-tai' -> 400", async () => {
  await silenceWarn(() =>
    withServer(makeApp(), async (base) => {
      const res = await fetch(`${base}/t`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ page: 1, limit: 10, action: "khong-ton-tai" }),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

test("FR-6: action là số -> 400 (không phải z.string() tự do)", async () => {
  await silenceWarn(() =>
    withServer(makeApp(), async (base) => {
      const res = await fetch(`${base}/t`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ page: 1, limit: 10, action: 123 }),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

/* ----------------------------------------------------- FR-1: auth guard (SC-1, SC-2) */

test("FR-1: POST /notifications/get không token -> 401, aggregate 0 lần", async () => {
  await postGet({ body: { page: 1, limit: 10 } }, async ({ res, agg }) => {
    assert.equal(res.status, 401);
    assert.equal(agg.calls, 0, "controller KHÔNG được chạy khi thiếu token");
  });
});

// Bất biến phải assert là "controller không chạy", KHÔNG phải con số status: `protectRoute` hiện
// trả 500 cho token hỏng (Out of Scope PRD, epic khác lo).
test("FR-1: token sai chữ ký -> non-2xx, aggregate 0 lần", async () => {
  const bad = jwt.sign({ userId: USER_X }, "sai-secret");
  await silenceError(() =>
    postGet(
      { cookie: `jwt=${bad}`, body: { page: 1, limit: 10 } },
      async ({ res, agg }) => {
        assert.ok(res.status >= 400, `phải non-2xx, nhận ${res.status}`);
        assert.equal(agg.calls, 0, "controller KHÔNG được chạy khi token hỏng");
      }
    )
  );
});

test("FR-1: body kèm userId của Y -> $match.toUsers là ObjectId(X), 0 lần xuất hiện Y", async () => {
  await postGet(
    {
      userId: USER_X,
      cookie: `jwt=${tokenFor(USER_X)}`,
      body: { userId: USER_Y, page: 1, limit: 10 },
    },
    async ({ res, agg }) => {
      assert.equal(res.status, 200);
      assert.equal(agg.calls, 1);
      const match = stageOf(agg.pipelines[0], "$match");
      assert.equal(
        String(match.toUsers),
        USER_X,
        "phải lọc theo danh tính JWT, KHÔNG theo userId trong body (S5/IDOR)"
      );
      assert.ok(
        !JSON.stringify(agg.pipelines[0]).includes(USER_Y),
        "id của Y không được xuất hiện ở bất kỳ đâu trong pipeline"
      );
    }
  );
});

/* -------------------------------------------------- FR-6: filter theo action (SC-14) */

test("FR-6: action='like' -> $match có action và đứng trước $skip", async () => {
  await postGet(
    {
      userId: USER_X,
      cookie: `jwt=${tokenFor(USER_X)}`,
      body: { page: 1, limit: 10, action: "like" },
    },
    async ({ res, agg }) => {
      assert.equal(res.status, 200);
      const pipeline = agg.pipelines[0];
      assert.equal(stageOf(pipeline, "$match").action, "like");
      assert.ok(
        stageIndex(pipeline, "$match") < stageIndex(pipeline, "$skip"),
        "$match phải đứng trước $skip để phân trang tính trên tập ĐÃ lọc"
      );
    }
  );
});

test("FR-6: không có action -> $match không có key action", async () => {
  await postGet(
    { userId: USER_X, cookie: `jwt=${tokenFor(USER_X)}`, body: { page: 1, limit: 10 } },
    async ({ res, agg }) => {
      assert.equal(res.status, 200);
      assert.ok(
        !("action" in stageOf(agg.pipelines[0], "$match")),
        "FE chưa deploy không gửi action -> tuyệt đối không được lọc"
      );
    }
  );
});

test("FR-6: action='all' -> $match không có key action (sentinel tab Tất cả)", async () => {
  await postGet(
    {
      userId: USER_X,
      cookie: `jwt=${tokenFor(USER_X)}`,
      body: { page: 1, limit: 10, action: "all" },
    },
    async ({ res, agg }) => {
      assert.equal(res.status, 200);
      assert.ok(
        !("action" in stageOf(agg.pipelines[0], "$match")),
        "'all' nghĩa là KHÔNG lọc — không document nào có action: 'all'"
      );
    }
  );
});

/* ------------------------------------------- FR-3: isRead trong $project (SC-12/SC-15b) */

test("FR-3: $project chứa $ifNull cho isRead (không phải isRead: 1)", async () => {
  await postGet(
    { userId: USER_X, cookie: `jwt=${tokenFor(USER_X)}`, body: { page: 1, limit: 10 } },
    async ({ res, agg }) => {
      assert.equal(res.status, 200);
      const project = stageOf(agg.pipelines[0], "$project");
      assert.deepEqual(
        project.isRead,
        { $ifNull: ["$isRead", false] },
        "document legacy KHÔNG có key isRead trên đĩa; isRead: 1 sẽ bỏ hẳn key khỏi output"
      );
    }
  );
});

/* --------------------------------------------------------------- wiring/structure */

test("notification.route.ts: validate() wired vào đúng 1 route", async () => {
  const src = await fs.readFile("src/api/routers/notification.route.ts", "utf8");
  const validateCalls = src.match(/validate\(/g) || [];
  assert.equal(validateCalls.length, 1, "phải có đúng 1 lần gọi validate(...)");
});
