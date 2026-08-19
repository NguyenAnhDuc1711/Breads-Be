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
import {
  getNotificationsSchema,
  readNotificationsSchema,
} from "../validators/notification.validator.ts";
import notificationRouter from "./notification.route.ts";
import { readNotifications } from "../controllers/notification.controller.ts";
import Notification from "../models/notification.model.ts";
import User from "../models/user.model.ts";
import { NotFoundError } from "../../core/error.response.ts";
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

// Task 013 (D-1): route đổi POST /get -> GET /, page/limit/action nay đọc từ req.query.
const makeApp = (echo = false) => {
  const app = express();
  app.use(express.json());
  app.get("/t", validate(getNotificationsSchema), (req, res) => {
    res.json(echo ? { query: req.query } : { ok: true });
  });
  app.use(errorHandler);
  return app;
};

// FR-3: harness trần cho schema `readNotificationsSchema` (XOR notificationId/markAll).
const makeReadApp = (echo = false) => {
  const app = express();
  app.use(express.json());
  app.post("/t", validate(readNotificationsSchema), (req, res) => {
    res.json(echo ? { body: req.body } : { ok: true });
  });
  app.use(errorHandler);
  return app;
};

// Pattern task 002 (`socket/controllers/notification.controller.test.ts`): stub property của
// object đã import, restore trong `finally`. Gán đè named export không có tác dụng dưới
// `npx tsx --test` — module gọi vẫn resolve về binding gốc.
const withStubbedModel = async (
  stubs: Array<[any, string, any]>,
  fn: () => Promise<void> | void
) => {
  const originals: Array<[any, string, any]> = stubs.map(([obj, prop]) => [
    obj,
    prop,
    obj[prop],
  ]);
  for (const [obj, prop, replacement] of stubs) {
    obj[prop] = replacement;
  }
  try {
    return await fn();
  } finally {
    for (const [obj, prop, original] of originals) {
      obj[prop] = original;
    }
  }
};

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

// TEST-6: đếm lần gọi `Notification.updateOne`/`updateMany` qua router thật — dùng cho test 401
// (chứng minh controller `readNotifications` không chạy khi thiếu token).
const stubNotificationWrites = () => {
  const originalUpdateOne = (Notification as any).updateOne;
  const originalUpdateMany = (Notification as any).updateMany;
  const calls = { updateOne: 0, updateMany: 0 };
  (Notification as any).updateOne = async () => {
    calls.updateOne++;
    return { matchedCount: 1 };
  };
  (Notification as any).updateMany = async () => {
    calls.updateMany++;
    return {};
  };
  return {
    calls,
    restore: () => {
      (Notification as any).updateOne = originalUpdateOne;
      (Notification as any).updateMany = originalUpdateMany;
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

// Task 013 (D-1): route đổi POST /get -> GET /. Gửi 1 request GET /api/notifications qua router
// THẬT với stub sẵn, params đi qua query string.
const postGet = async (
  { userId, cookie, query }: { userId?: string; cookie?: string; query: Record<string, string> },
  assertFn: (ctx: { res: any; agg: ReturnType<typeof stubAggregate> }) => void | Promise<void>
) => {
  const restoreUser = stubUser(userId ?? USER_X);
  const agg = stubAggregate();
  try {
    await withServer(makeRouterApp(), async (base) => {
      const qs = new URLSearchParams(query).toString();
      const res = await fetch(`${base}/api/notifications?${qs}`, {
        method: "GET",
        headers: {
          ...(cookie ? { cookie } : {}),
        },
      });
      await assertFn({ res: res as any, agg });
    });
  } finally {
    agg.restore();
    restoreUser();
  }
};

/* ------------------------------------------------ getNotificationsSchema (query, task 013) */

test("getNotificationsSchema: query hợp lệ -> 200", async () => {
  await withServer(makeApp(true), async (base) => {
    const res = await fetch(`${base}/t?page=1&limit=10`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { query: { page: 1, limit: 10 } });
  });
});

// FR-1: `userId` đã bị XOÁ khỏi schema — query không có nó nay là hợp đồng ĐÚNG, không còn là 400.
test("getNotificationsSchema: không có userId -> 200 (userId đã rời schema)", async () => {
  await withServer(makeApp(true), async (base) => {
    const res = await fetch(`${base}/t?page=1&limit=10`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { query: { page: 1, limit: 10 } });
  });
});

// NFR-1 (backward compat): FE cũ chưa deploy vẫn gửi `userId`. `z.object()` STRIP key không khai
// báo -> 200, và key biến mất khỏi `req.query` trước khi tới controller. Đây là bằng chứng cho lựa
// chọn "xoá key khỏi schema" thay vì "đối chiếu với req.user._id" (AD-2/R-2).
test("FR-1: query thừa userId -> 200 và userId bị strip khỏi req.query", async () => {
  await withServer(makeApp(true), async (base) => {
    const res = await fetch(`${base}/t?userId=${VALID_ID}&page=1&limit=10`);
    assert.equal(res.status, 200);
    const payload: any = await res.json();
    assert.deepEqual(payload, { query: { page: 1, limit: 10 } });
    assert.ok(
      !("userId" in payload.query),
      "userId phải bị strip, không được đi tiếp vào controller"
    );
  });
});

// Task 013: route đổi sang GET -> page/limit PHẢI coerce từ query string, khác hành vi body cũ
// (AD-5 cho body vẫn áp dụng ở các route khác, VD sendReportSchema).
test("Task 013: getNotificationsSchema: query string \"2\" coerce thành number 2", async () => {
  await withServer(makeApp(true), async (base) => {
    const res = await fetch(`${base}/t?page=2&limit=10`);
    assert.equal(res.status, 200);
    const payload: any = await res.json();
    assert.deepEqual(payload, { query: { page: 2, limit: 10 } });
    assert.equal(typeof payload.query.page, "number", "page phải là number sau coerce, không phải string");
  });
});

test("FR-1: thiếu page -> 400 (page/limit vẫn bắt buộc sau khi bỏ userId)", async () => {
  await silenceWarn(() =>
    withServer(makeApp(), async (base) => {
      const res = await fetch(`${base}/t?limit=10`);
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

test("FR-6: action='khong-ton-tai' -> 400", async () => {
  await silenceWarn(() =>
    withServer(makeApp(), async (base) => {
      const res = await fetch(`${base}/t?page=1&limit=10&action=khong-ton-tai`);
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

test("FR-6: action='123' (chuỗi số) -> 400 (không thuộc enum)", async () => {
  await silenceWarn(() =>
    withServer(makeApp(), async (base) => {
      const res = await fetch(`${base}/t?page=1&limit=10&action=123`);
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

/* ----------------------------------------------------- FR-1: auth guard (SC-1, SC-2) */

test("FR-1: GET /notifications không token -> 401, aggregate 0 lần", async () => {
  await postGet({ query: { page: "1", limit: "10" } }, async ({ res, agg }) => {
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
      { cookie: `jwt=${bad}`, query: { page: "1", limit: "10" } },
      async ({ res, agg }) => {
        assert.ok(res.status >= 400, `phải non-2xx, nhận ${res.status}`);
        assert.equal(agg.calls, 0, "controller KHÔNG được chạy khi token hỏng");
      }
    )
  );
});

test("FR-1: query kèm userId của Y -> $match.toUsers là ObjectId(X), 0 lần xuất hiện Y", async () => {
  await postGet(
    {
      userId: USER_X,
      cookie: `jwt=${tokenFor(USER_X)}`,
      query: { userId: USER_Y, page: "1", limit: "10" },
    },
    async ({ res, agg }) => {
      assert.equal(res.status, 200);
      assert.equal(agg.calls, 1);
      const match = stageOf(agg.pipelines[0], "$match");
      assert.equal(
        String(match.toUsers),
        USER_X,
        "phải lọc theo danh tính JWT, KHÔNG theo userId trong query (S5/IDOR)"
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
      query: { page: "1", limit: "10", action: "like" },
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
    { userId: USER_X, cookie: `jwt=${tokenFor(USER_X)}`, query: { page: "1", limit: "10" } },
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
      query: { page: "1", limit: "10", action: "all" },
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
    { userId: USER_X, cookie: `jwt=${tokenFor(USER_X)}`, query: { page: "1", limit: "10" } },
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

/* -------------------------------------------- FR-3: readNotificationsSchema (XOR, TEST) */

test("FR-3: XOR cả notificationId lẫn markAll -> 400", async () => {
  await silenceWarn(() =>
    withServer(makeReadApp(), async (base) => {
      const res = await fetch(`${base}/t`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notificationId: VALID_ID, markAll: true }),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

test("FR-3: XOR không key nào -> 400", async () => {
  await silenceWarn(() =>
    withServer(makeReadApp(), async (base) => {
      const res = await fetch(`${base}/t`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

test("FR-3: markAll: false -> 400 (z.literal(true), không phải z.boolean())", async () => {
  await silenceWarn(() =>
    withServer(makeReadApp(), async (base) => {
      const res = await fetch(`${base}/t`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ markAll: false }),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

/* ---------------------------------------------- FR-3: readNotifications controller (ARCH-1) */

test("FR-3: markAll -> updateMany filter có isRead: {$ne: true} (không phải false)", async () => {
  let updateManyArgs: any;
  await withStubbedModel(
    [
      [
        Notification,
        "updateMany",
        async (filter: any, update: any) => {
          updateManyArgs = [filter, update];
          return { matchedCount: 5, modifiedCount: 5 };
        },
      ],
      [Notification, "exists", async () => null],
      [User, "updateOne", async () => ({})],
    ],
    async () => {
      const req: any = { user: { _id: USER_X }, body: { markAll: true } };
      const res = fakeRes();
      await readNotifications(req, res);
      assert.equal(res.statusCode, 200);
      const [filter, update] = updateManyArgs;
      assert.equal(String(filter.toUsers.$in[0]), USER_X);
      assert.equal(filter.toUsers.$in.length, 1);
      assert.deepEqual(
        filter.isRead,
        { $ne: true },
        "phải là $ne: true, KHÔNG BAO GIỜ isRead: false (ARCH-1)"
      );
      assert.deepEqual(update, { isRead: true });
    }
  );
});

test("FR-3: exists trả null -> User.updateOne({hasNewNotify: false})", async () => {
  let userUpdateArgs: any;
  await withStubbedModel(
    [
      [Notification, "updateMany", async () => ({ matchedCount: 0 })],
      [Notification, "exists", async () => null],
      [
        User,
        "updateOne",
        async (filter: any, update: any) => {
          userUpdateArgs = [filter, update];
          return {};
        },
      ],
    ],
    async () => {
      const req: any = { user: { _id: USER_X }, body: { markAll: true } };
      const res = fakeRes();
      await readNotifications(req, res);
      assert.deepEqual(userUpdateArgs[1], { hasNewNotify: false });
      assert.equal(String(userUpdateArgs[0]._id), USER_X);
    }
  );
});

test("FR-3: exists trả document -> User.updateOne({hasNewNotify: true})", async () => {
  let userUpdateArgs: any;
  await withStubbedModel(
    [
      [Notification, "updateMany", async () => ({ matchedCount: 0 })],
      [Notification, "exists", async () => ({ _id: VALID_ID })],
      [
        User,
        "updateOne",
        async (filter: any, update: any) => {
          userUpdateArgs = [filter, update];
          return {};
        },
      ],
    ],
    async () => {
      const req: any = { user: { _id: USER_X }, body: { markAll: true } };
      const res = fakeRes();
      await readNotifications(req, res);
      assert.deepEqual(userUpdateArgs[1], { hasNewNotify: true });
    }
  );
});

test("FR-3: filter exists cùng hình dạng với updateMany (toUsers.$in + $ne: true)", async () => {
  let updateManyFilter: any;
  let existsFilter: any;
  await withStubbedModel(
    [
      [
        Notification,
        "updateMany",
        async (filter: any) => {
          updateManyFilter = filter;
          return { matchedCount: 0 };
        },
      ],
      [
        Notification,
        "exists",
        async (filter: any) => {
          existsFilter = filter;
          return null;
        },
      ],
      [User, "updateOne", async () => ({})],
    ],
    async () => {
      const req: any = { user: { _id: USER_X }, body: { markAll: true } };
      const res = fakeRes();
      await readNotifications(req, res);
      assert.equal(
        String(existsFilter.toUsers.$in[0]),
        String(updateManyFilter.toUsers.$in[0])
      );
      assert.deepEqual(existsFilter.isRead, updateManyFilter.isRead);
      assert.deepEqual(existsFilter.isRead, { $ne: true });
    }
  );
});

test("FR-3: notificationId -> updateOne filter có _id + toUsers.$in, set isRead: true", async () => {
  let updateOneArgs: any;
  await withStubbedModel(
    [
      [
        Notification,
        "updateOne",
        async (filter: any, update: any) => {
          updateOneArgs = [filter, update];
          return { matchedCount: 1, modifiedCount: 1 };
        },
      ],
      [Notification, "exists", async () => null],
      [User, "updateOne", async () => ({})],
    ],
    async () => {
      const req: any = {
        user: { _id: USER_X },
        body: { notificationId: VALID_ID },
      };
      const res = fakeRes();
      await readNotifications(req, res);
      assert.equal(res.statusCode, 200);
      const [filter, update] = updateOneArgs;
      assert.equal(String(filter._id), VALID_ID);
      assert.equal(String(filter.toUsers.$in[0]), USER_X);
      assert.deepEqual(update, { isRead: true });
    }
  );
});

test("FR-3: matchedCount === 0 -> NotFoundError (404, không 403), User.updateOne không chạy", async () => {
  let userUpdateCalls = 0;
  await withStubbedModel(
    [
      [Notification, "updateOne", async () => ({ matchedCount: 0 })],
      [Notification, "exists", async () => null],
      [
        User,
        "updateOne",
        async () => {
          userUpdateCalls++;
          return {};
        },
      ],
    ],
    async () => {
      const req: any = {
        user: { _id: USER_X },
        body: { notificationId: VALID_ID },
      };
      const res = fakeRes();
      await assert.rejects(
        () => readNotifications(req, res),
        (err: any) =>
          err instanceof NotFoundError && (err as any).statusCode === 404
      );
      assert.equal(
        userUpdateCalls,
        0,
        "nhánh 404 phải thoát TRƯỚC recompute hasNewNotify"
      );
    }
  );
});

/* ------------------------------------------------------- FR-3/TEST-6: auth guard route mới */

test("FR-3/TEST-6: PATCH /notifications/read không token -> 401, updateOne/updateMany 0 lần", async () => {
  const writes = stubNotificationWrites();
  try {
    await withServer(makeRouterApp(), async (base) => {
      const res = await fetch(`${base}/api/notifications/read`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ markAll: true }),
      });
      assert.equal(res.status, 401);
      assert.equal(writes.calls.updateOne, 0);
      assert.equal(writes.calls.updateMany, 0);
    });
  } finally {
    writes.restore();
  }
});

test("FR-3/TEST-6: router.use(protectRoute) đứng trước mọi router.get(/router.patch(", async () => {
  const src = await fs.readFile("src/api/routers/notification.route.ts", "utf8");
  const protectIdx = src.indexOf("router.use(protectRoute)");
  assert.notEqual(protectIdx, -1, "phải mount protectRoute ở router level");
  // Task 013 (D-1): GET /get -> GET / (đổi từ POST). Regex cập nhật theo method mới.
  const routeRegex = /router\.(get|patch)\(/g;
  const routeIndices: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = routeRegex.exec(src)) !== null) {
    routeIndices.push(m.index);
  }
  assert.ok(
    routeIndices.length >= 2,
    "phải có ít nhất 2 route (GET / + PATCH /read)"
  );
  for (const idx of routeIndices) {
    assert.ok(
      protectIdx < idx,
      "protectRoute phải đứng trước mọi router.get(/router.patch("
    );
  }
});

/* --------------------------------------------------------------- wiring/structure */

test("notification.route.ts: validate() wired vào đúng 2 route", async () => {
  const src = await fs.readFile("src/api/routers/notification.route.ts", "utf8");
  const validateCalls = src.match(/validate\(/g) || [];
  assert.equal(validateCalls.length, 2, "phải có đúng 2 lần gọi validate(...) (GET + READ)");
});
