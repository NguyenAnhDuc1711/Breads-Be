// Run with Node's built-in test runner: `npm test`.
//
// Phạm vi: Task 010 — schema cho 9 route auth/profile của `user.route.ts` (getMe, getUserProfile,
// signupUser, loginUser, logoutUser, followUser, updateUser, changePassword,
// validateEmailByCode). Task 011 sẽ append test cho 9 route listing/admin còn lại vào CHÍNH file
// này — không xoá/định dạng lại test có sẵn khi merge.
//
// 2 tầng test theo pattern AD-7 (task 001, `validate.test.ts`):
//  - Tầng schema (gọi `.parse()`/`.body.parse()` trực tiếp): kiểm hình dạng field, độc lập với
//    HTTP/DB.
//  - Tầng HTTP (mount ROUTER THẬT `user.route.ts` trần trên 1 `express()` mới, không import
//    `app.ts`, không cần Mongo/Redis): chỉ dùng cho các path mà `validate()` chặn TRƯỚC khi chạm
//    controller (negative path, hoặc route không có schema) — path nào chạm DB thật (vd
//    `followUser` gọi `User.findOne`) KHÔNG được test qua tầng này.
import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import express from "express";
import { z } from "zod";
import {
  getUserProfileSchema,
  signupUserSchema,
  loginUserSchema,
  followUserSchema,
  updateUserSchema,
  changePasswordSchema,
  validateEmailByCodeSchema,
  getUsersFollowQuerySchema,
  getUserToFollowsQuerySchema,
  getUsersToTagQuerySchema,
  getUsersWithStatusQuerySchema,
  getUsersPendingPostSchema,
  checkValidUserSchema,
  getUserIdFromEmailSchema,
  getSitemapEligibleUsersQuerySchema,
} from "../validators/user.validator.ts";
import userRouter from "./user.route.ts";
import { VALIDATION_ERROR_MESSAGE, validate } from "../middlewares/validate.ts";
import { getSitemapEligibleUsers } from "../controllers/user.controller.ts";
import sitemapAuthGate, {
  SITEMAP_SECRET_HEADER,
} from "../middlewares/sitemapAuthGate.ts";
import asyncHandler from "../../helpers/asyncHandler.ts";
import User from "../models/user.model.ts";

const VALID_OBJECT_ID = "652f1b2c3d4e5f6071829304";
const VALID_OBJECT_ID_2 = "652f1b2c3d4e5f6071829305";

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

/* -------------------------------------------------------------- tầng schema */

test("signupUserSchema: body hợp lệ pass", () => {
  assert.doesNotThrow(() =>
    signupUserSchema.body.parse({
      name: "Duc",
      email: "duc@example.com",
      username: "duc",
      password: "123456",
    })
  );
});

test("signupUserSchema: thiếu email fail", () => {
  assert.throws(
    () =>
      signupUserSchema.body.parse({
        name: "Duc",
        username: "duc",
        password: "123456",
      }),
    z.ZodError
  );
});

test("signupUserSchema: email sai định dạng fail", () => {
  assert.throws(
    () =>
      signupUserSchema.body.parse({
        name: "Duc",
        email: "not-an-email",
        username: "duc",
        password: "123456",
      }),
    z.ZodError
  );
});

test("signupUserSchema: thiếu password fail", () => {
  assert.throws(
    () =>
      signupUserSchema.body.parse({
        name: "Duc",
        email: "duc@example.com",
        username: "duc",
      }),
    z.ZodError
  );
});

test("loginUserSchema: {email, password} hợp lệ pass", () => {
  assert.doesNotThrow(() =>
    loginUserSchema.body.parse({ email: "duc@example.com", password: "x" })
  );
});

test("loginUserSchema: thiếu email fail", () => {
  assert.throws(
    () => loginUserSchema.body.parse({ password: "x" }),
    z.ZodError
  );
});

test("loginUserSchema: thiếu password fail", () => {
  assert.throws(
    () => loginUserSchema.body.parse({ email: "duc@example.com" }),
    z.ZodError
  );
});

test("followUserSchema: {userFlId, userId} hợp lệ (ObjectId thật) pass — giữ nguyên tên field", () => {
  const result = followUserSchema.body.parse({
    userFlId: VALID_OBJECT_ID,
    userId: VALID_OBJECT_ID_2,
  });
  assert.deepEqual(result, {
    userFlId: VALID_OBJECT_ID,
    userId: VALID_OBJECT_ID_2,
  });
});

test("followUserSchema: thiếu userFlId fail", () => {
  assert.throws(
    () => followUserSchema.body.parse({ userId: VALID_OBJECT_ID_2 }),
    z.ZodError
  );
});

test("followUserSchema: thiếu userId fail", () => {
  assert.throws(
    () => followUserSchema.body.parse({ userFlId: VALID_OBJECT_ID }),
    z.ZodError
  );
});

test("followUserSchema: userFlId không phải ObjectId fail", () => {
  assert.throws(
    () =>
      followUserSchema.body.parse({
        userFlId: "not-an-id",
        userId: VALID_OBJECT_ID_2,
      }),
    z.ZodError
  );
});

test("followUserSchema: userId không phải ObjectId fail", () => {
  assert.throws(
    () =>
      followUserSchema.body.parse({
        userFlId: VALID_OBJECT_ID,
        userId: "not-an-id",
      }),
    z.ZodError
  );
});

test("updateUserSchema: params.id không phải ObjectId fail (bất kể body)", () => {
  assert.throws(
    () => updateUserSchema.params.parse({ id: "not-an-id" }),
    z.ZodError
  );
});

test("updateUserSchema: params.id hợp lệ pass", () => {
  assert.doesNotThrow(() =>
    updateUserSchema.params.parse({ id: VALID_OBJECT_ID })
  );
});

test("changePasswordSchema: chỉ forgotPW: true (không currentPW/newPW) vẫn pass ở tầng schema", () => {
  assert.doesNotThrow(() =>
    changePasswordSchema.body.parse({ forgotPW: true })
  );
});

test("validateEmailByCodeSchema: thiếu code fail", () => {
  assert.throws(
    () => validateEmailByCodeSchema.body.parse({ email: "duc@example.com" }),
    z.ZodError
  );
});

test("validateEmailByCodeSchema: {email, code} hợp lệ pass", () => {
  assert.doesNotThrow(() =>
    validateEmailByCodeSchema.body.parse({
      email: "duc@example.com",
      code: "123456",
    })
  );
});

/* ---------------------------------------------------------------- tầng HTTP */

test("FR-4 (signup): thiếu email -> 400, signupUser không được gọi (không có lỗi liên quan DB nào xảy ra)", async () => {
  await withServer(mountUserRouter(), async (base) => {
    const res = await fetch(`${base}/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Duc",
        username: "duc",
        password: "123456",
      }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
  });
});

test("FR-4 (login, email format): {email: 'not-an-email', password: 'x'} -> 400", async () => {
  await withServer(mountUserRouter(), async (base) => {
    const res = await fetch(`${base}/users/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "not-an-email", password: "x" }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
  });
});

test("FR-4 (ObjectId param): GET /users/not-an-id -> 400 trước khi getUserProfile chạy (PROFILE = '/:userId', đăng ký sau cùng nhóm GET)", async () => {
  await withServer(mountUserRouter(), async (base) => {
    const res = await fetch(`${base}/users/not-an-id`);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
  });
});

test("FR-4 (no-schema route): POST /users/sessions/logout không đổi hành vi — vẫn 200 bất kể body", async () => {
  await withServer(mountUserRouter(), async (base) => {
    const res = await fetch(`${base}/users/sessions/logout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ anything: "goes" }),
    });
    assert.equal(res.status, 200);
  });
});

test("FR-4 (no-schema route): GET /users/me không có validate() chen vào — vẫn 401 (protectRoute) như trước khi có task này, không phải 400 validate", async () => {
  await withServer(mountUserRouter(), async (base) => {
    const res = await fetch(`${base}/users/me`);
    assert.equal(res.status, 401);
    const json = (await res.json()) as { message?: string };
    assert.notEqual(json.message, VALIDATION_ERROR_MESSAGE);
  });
});

// ================================================================
// Task 011 — 9 route listing/admin còn lại của `user.route.ts`
// ================================================================

/* -------------------------------------------------------------- tầng schema */

test("getUsersFollowQuerySchema: limit=50 (boundary) pass", () => {
  assert.doesNotThrow(() =>
    getUsersFollowQuerySchema.query.parse({
      userId: VALID_OBJECT_ID,
      type: "following",
      limit: "50",
    })
  );
});

test("getUsersFollowQuerySchema: limit=51 fail (cap .max(50) local cho router này)", () => {
  assert.throws(
    () =>
      getUsersFollowQuerySchema.query.parse({
        userId: VALID_OBJECT_ID,
        type: "following",
        limit: "51",
      }),
    z.ZodError
  );
});

test("getUsersFollowQuerySchema: type=bogus fail", () => {
  assert.throws(
    () =>
      getUsersFollowQuerySchema.query.parse({
        userId: VALID_OBJECT_ID,
        type: "bogus",
      }),
    z.ZodError
  );
});

test("getUsersFollowQuerySchema: type=following pass", () => {
  assert.doesNotThrow(() =>
    getUsersFollowQuerySchema.query.parse({
      userId: VALID_OBJECT_ID,
      type: "following",
    })
  );
});

test("getUserToFollowsQuerySchema: isTest=false parse ra boolean false thật (không phải truthy string)", () => {
  const result = getUserToFollowsQuerySchema.query.parse({ isTest: "false" });
  assert.equal(result.isTest, false);
});

test("getUserToFollowsQuerySchema: isTest=true parse ra boolean true", () => {
  const result = getUserToFollowsQuerySchema.query.parse({ isTest: "true" });
  assert.equal(result.isTest, true);
});

test("getUserToFollowsQuerySchema: isTest vắng mặt -> undefined (optional)", () => {
  const result = getUserToFollowsQuerySchema.query.parse({});
  assert.equal(result.isTest, undefined);
});

test("getUsersToTagQuerySchema: shape hợp lệ pass", () => {
  assert.doesNotThrow(() =>
    getUsersToTagQuerySchema.query.parse({
      userId: VALID_OBJECT_ID,
      page: "1",
      limit: "20",
      searchValue: "duc",
    })
  );
});

test("getUsersToTagQuerySchema: page không phải số fail", () => {
  assert.throws(
    () =>
      getUsersToTagQuerySchema.query.parse({
        userId: VALID_OBJECT_ID,
        page: "abc",
      }),
    z.ZodError
  );
});

test("getUsersWithStatusQuerySchema: shape hợp lệ pass", () => {
  assert.doesNotThrow(() =>
    getUsersWithStatusQuerySchema.query.parse({
      userId: VALID_OBJECT_ID,
      page: "1",
      limit: "20",
    })
  );
});

test("getUsersWithStatusQuerySchema: page không phải số fail", () => {
  assert.throws(
    () =>
      getUsersWithStatusQuerySchema.query.parse({
        userId: VALID_OBJECT_ID,
        page: "abc",
      }),
    z.ZodError
  );
});

test("getUsersPendingPostSchema: shape hợp lệ pass", () => {
  assert.doesNotThrow(() =>
    getUsersPendingPostSchema.body.parse({
      userId: VALID_OBJECT_ID,
      page: 1,
      limit: 20,
    })
  );
});

test("getUsersPendingPostSchema: page không phải số fail", () => {
  assert.throws(
    () =>
      getUsersPendingPostSchema.body.parse({
        userId: VALID_OBJECT_ID,
        page: "abc",
      }),
    z.ZodError
  );
});

test("checkValidUserSchema: chỉ userId (không userEmail) vẫn pass ở tầng schema — either-or là business rule ở controller", () => {
  assert.doesNotThrow(() =>
    checkValidUserSchema.body.parse({ userId: VALID_OBJECT_ID })
  );
});

test("checkValidUserSchema: cả userId lẫn userEmail đều thiếu vẫn pass ở tầng schema (xác nhận task này không dời business logic vào schema)", () => {
  assert.doesNotThrow(() => checkValidUserSchema.body.parse({}));
});

test("getUserIdFromEmailSchema: thiếu userEmail fail", () => {
  assert.throws(
    () => getUserIdFromEmailSchema.body.parse({}),
    z.ZodError
  );
});

test("getUserIdFromEmailSchema: userEmail hợp lệ pass", () => {
  assert.doesNotThrow(() =>
    getUserIdFromEmailSchema.body.parse({ userEmail: "duc@example.com" })
  );
});

test("getUsersPendingPostSchema: limit=1000 KHÔNG bị chặn (cap .max(50) của getUsersFollow không leak sang route body này)", () => {
  assert.doesNotThrow(() =>
    getUsersPendingPostSchema.body.parse({
      userId: VALID_OBJECT_ID,
      page: 1,
      limit: 1000,
    })
  );
});

/* ---------------------------------------------------------------- tầng HTTP */
// Lưu ý: `handleCrawlFakeUsers` (crawlUser) chạm DB/mạng thật ngay cả khi input hợp lệ (route
// không có schema nên validate() không chặn được gì trước đó) — theo đúng rule ở đầu file, KHÔNG
// test route này qua tầng HTTP; "không có validate() chen vào" được xác nhận qua code review +
// checklist `grep -c "validate("` thủ công.

test("FR-4 (pagination cap, local): GET /users/follow-list?limit=1000 -> 400 (vượt cap .max(50))", async () => {
  await withServer(mountUserRouter(), async (base) => {
    const res = await fetch(
      `${base}/users/follow-list?userId=${VALID_OBJECT_ID}&type=following&limit=1000`
    );
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
  });
});

test("FR-4 (type enum): GET /users/follow-list?type=bogus -> 400 trước khi getUsersFollow chạy", async () => {
  await withServer(mountUserRouter(), async (base) => {
    const res = await fetch(
      `${base}/users/follow-list?userId=${VALID_OBJECT_ID}&type=bogus`
    );
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
  });
});

test("FR-4 (checkValidUser, body rỗng): POST /users/validity-checks với body {} -> KHÔNG phải lỗi validate (either-or vẫn là controller kiểm, throw sớm trước khi chạm DB)", async () => {
  await withServer(mountUserRouter(), async (base) => {
    const res = await fetch(`${base}/users/validity-checks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const json = (await res.json().catch(() => ({}))) as {
      message?: string;
    };
    assert.notEqual(json.message, VALIDATION_ERROR_MESSAGE);
  });
});

// ================================================================
// Task 020 — positive path (NFR-4): payload HỢP LỆ vẫn đi lọt `validate()`
// ================================================================
//
// Mọi test HTTP ở trên đều là negative (400) hoặc route không có schema. Nếu `validate()` lỡ chặn
// nhầm payload đúng, hoặc `req.body`/`req.query`/`req.params` bị reassignment (AD-6) làm rơi field,
// KHÔNG test nào ở trên fail.
//
// `user.route.ts` là router DUY NHẤT dùng cả 3 mặt reassignment, nhưng mọi route có schema của nó
// đều đi thẳng vào controller chạm DB (`User.findOne`...), nên không mount router thật được (rule ở
// đầu file). Dùng pattern của `post.route.test.ts`: SCHEMA THẬT + `validate()` THẬT + handler stub —
// chạm được stub nghĩa là validate() đã cho qua. Wiring "schema nào gắn route nào" đã được các test
// negative phía trên (chạy qua router THẬT) và checklist `grep -c "validate("` bảo chứng.
const mountEcho = (method: "get" | "post", path: string, schema) => {
  const app = express();
  app.use(express.json());
  app[method](path, validate(schema), (req, res) => {
    res.json({ body: req.body, query: req.query, params: req.params });
  });
  app.use(errorHandler);
  return app;
};

test("NFR-4 (positive, body): signup payload hợp lệ chạm controller, đủ 4 field", async () => {
  const payload = {
    name: "Duc",
    email: "duc@example.com",
    username: "duc",
    password: "123456",
  };

  await withServer(mountEcho("post", "/users", signupUserSchema), async (base) => {
    const res = await fetch(`${base}/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { body: Record<string, unknown> };
    assert.deepEqual(json.body, payload, "reassignment không được làm rơi/đổi field nào");
  });
});

test("NFR-4 (positive, query): follow-list query hợp lệ chạm controller, page/limit coerce đúng kiểu", async () => {
  await withServer(
    mountEcho("get", "/users/follow-list", getUsersFollowQuerySchema),
    async (base) => {
      const res = await fetch(
        `${base}/users/follow-list?userId=${VALID_OBJECT_ID}&type=following&page=2&limit=50`
      );
      assert.equal(res.status, 200);
      const json = (await res.json()) as { query: any };
      assert.equal(json.query.userId, VALID_OBJECT_ID);
      assert.equal(json.query.type, "following");
      assert.equal(json.query.page, 2, "query phải được coerce sang number (AD-5)");
      assert.equal(json.query.limit, 50, "limit=50 là boundary hợp lệ, không được bị chặn");
    }
  );
});

test("NFR-4 (positive, params): GET /users/:userId với ObjectId hợp lệ chạm controller", async () => {
  await withServer(
    mountEcho("get", "/users/:userId", getUserProfileSchema),
    async (base) => {
      const res = await fetch(`${base}/users/${VALID_OBJECT_ID}`);
      assert.equal(res.status, 200);
      const json = (await res.json()) as { params: Record<string, unknown> };
      assert.deepEqual(json.params, { userId: VALID_OBJECT_ID });
    }
  );
});

test("FR-4 (getUserIdFromEmail): thiếu userEmail -> 400 trước khi controller chạy", async () => {
  await withServer(mountUserRouter(), async (base) => {
    const res = await fetch(`${base}/users/id-lookup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
  });
});

// ================================================================
// Task 010 — bảng redesign 19 endpoint (epic restful-api-redesign, D-1)
// ================================================================
//
// Route như CRAWL_USER/REFRESH_TOKEN chạm DB/mạng thật ngay cả với input hợp lệ và không có
// validate() chặn trước (đúng rule ở đầu file — KHÔNG test qua tầng HTTP round-trip). "Happy-path
// qua route/method mới" cho ĐỦ 19 endpoint (18 gốc + `SITEMAP_ELIGIBLE` task 003, sau khi bỏ route
// backdoor GET /admin không xác thực — security-hardening) được đảm bảo ở đây bằng cách đọc trực
// tiếp `userRouter.stack` (router THẬT, KHÔNG parse lại source) và so khớp 1-1 (method, path) với
// đúng thứ tự đăng ký — thứ tự QUAN TRỌNG vì PROFILE ("/:userId") và UPDATE ("/:id") là catch-all
// 1-segment, phải đứng SAU các path literal cùng số segment (/me, /follow-list, /with-status,
// /sitemap-eligible, /follow) để không "nuốt" chúng (xem comment trong user.route.ts).
test("FR-2 (D-1): user.route.ts wiring khớp đúng 19 (method, path) mới, đúng thứ tự chống shadow route động", () => {
  const routes = userRouter.stack
    .filter((layer: any) => layer.route)
    .map((layer: any) => ({
      method: Object.keys(layer.route.methods)[0],
      path: layer.route.path,
    }));

  const expected = [
    { method: "get", path: "/me" },
    { method: "get", path: "/follow-list" },
    { method: "get", path: "/suggestions/to-follow" },
    { method: "get", path: "/suggestions/to-tag" },
    { method: "get", path: "/with-status" },
    { method: "get", path: "/sitemap-eligible" }, // MỚI (task 003): user đủ điều kiện sitemap, literal -> trước /:userId
    { method: "get", path: "/:userId" },
    { method: "post", path: "/pending-post-lookup" },
    { method: "post", path: "/" },
    { method: "post", path: "/sessions" },
    { method: "post", path: "/sessions/logout" },
    { method: "post", path: "/sessions/refresh" },
    { method: "put", path: "/follow" },
    { method: "put", path: "/:id" },
    { method: "put", path: "/:id/password" },
    { method: "post", path: "/crawl" },
    { method: "post", path: "/validity-checks" },
    { method: "post", path: "/id-lookup" },
    { method: "post", path: "/email-validations" },
  ];

  assert.equal(routes.length, 19, "phải có đúng 19 route đăng ký trên router");
  assert.deepEqual(
    routes,
    expected,
    "method+path (và thứ tự đăng ký) phải khớp đúng bảng redesign 010.md + SITEMAP_ELIGIBLE task 003, trừ backdoor GET /admin đã gỡ"
  );
});

// ================================================================
// Task 003 (epic seo-sitemap-schema, FR-2): GET /users/sitemap-eligible — sibling của
// /posts/sitemap-eligible (task 002, post.route.test.ts). CỐ Ý KHÔNG mount `sitemapListLimiter`
// thật khi 1 test gọi lặp lại nhiều lần trong CÙNG file (singleton module-level, dùng chung state
// cả process test — mount nó vào 1 route bị gọi nhiều lần có thể tự trip giữa chừng, che mất
// assertion thật đang test, đúng lý do post.route.test.ts:868 đã né tương tự) — dùng app tối giản
// mirror đúng wiring (trừ rate limiter) cho auth-gate/phân trang; sự có mặt của `sitemapListLimiter`
// trên route thật được xác nhận riêng bằng test đọc SOURCE bên dưới. Test route-shadowing regression
// (khác biệt so với task 002: user.route.ts có route dynamic `/:userId` SIBLING thật sự, nên phải
// dùng `userRouter` THẬT — không phải app tối giản — mới bắt được bug lớp này) mount `userRouter`.
// ================================================================

const SITEMAP_SECRET = "test-sitemap-secret";

const withSitemapSecret = async (fn: () => Promise<void> | void) => {
  process.env.SITEMAP_SHARED_SECRET = SITEMAP_SECRET;
  try {
    await fn();
  } finally {
    delete process.env.SITEMAP_SHARED_SECRET;
  }
};

/** Mirror ĐÚNG wiring thật của `SITEMAP_ELIGIBLE` trong `user.route.ts` (trừ `sitemapListLimiter`,
 * lý do xem comment ngay trên): `sitemapAuthGate` -> `validate(...)` -> controller thật. */
const sitemapEligibleUsersApp = () => {
  const app = express();
  const router = express.Router();
  router.get(
    "/sitemap-eligible",
    sitemapAuthGate,
    validate(getSitemapEligibleUsersQuerySchema),
    asyncHandler(getSitemapEligibleUsers),
  );
  app.use("/users", router);
  app.use(errorHandler);
  return app;
};

test("FR-2 (auth gate): thiếu header secret -> 401, không chạm controller", async () => {
  await withSitemapSecret(async () => {
    await withServer(sitemapEligibleUsersApp(), async (base) => {
      const res = await fetch(`${base}/users/sitemap-eligible`);
      assert.equal(res.status, 401);
    });
  });
});

test("FR-2 (auth gate): sai header secret -> 401", async () => {
  await withSitemapSecret(async () => {
    await withServer(sitemapEligibleUsersApp(), async (base) => {
      const res = await fetch(`${base}/users/sitemap-eligible`, {
        headers: { [SITEMAP_SECRET_HEADER]: "wrong-secret" },
      });
      assert.equal(res.status, 401);
    });
  });
});

// 25 doc giả lập kết quả ĐÃ QUA filter status/followersCount (đúng field controller select), _id
// hex 24 ký tự tăng dần để so sánh chuỗi `>` tương đương thứ tự ObjectId thật.
const FAKE_ELIGIBLE_USER_DOCS = Array.from({ length: 25 }, (_, i) => ({
  _id: String(i + 1).padStart(24, "0"),
  updatedAt: new Date(2024, 0, i + 1),
  followersCount: 10 + i,
}));

// Mock giả lập ĐÚNG hành vi query thật (top-N ưu tiên, fix sau epic seo-sitemap-schema): sort
// (followersCount giảm dần, _id giảm dần) + cursor $or "followersCount:id" — KHÔNG còn thuần `_id`.
const withStubbedUserFind = async (
  docs: typeof FAKE_ELIGIBLE_USER_DOCS,
  fn: () => Promise<void> | void,
) => {
  const originalFind = (User as any).find;
  const originalCountDocuments = (User as any).countDocuments;

  // "Backend thật" luôn trả theo (followersCount giảm dần, _id giảm dần).
  const ranked = [...docs].sort((a, b) =>
    a.followersCount !== b.followersCount
      ? b.followersCount - a.followersCount
      : b._id.localeCompare(a._id),
  );

  (User as any).find = (filter: any) => {
    const orClause = filter?.$or as
      | [{ followersCount: { $lt: number } }, { followersCount: number; _id: { $lt: string } }]
      | undefined;
    const matched = orClause
      ? ranked.filter((d) => {
          const [ltScore, eqScoreLtId] = orClause;
          return (
            d.followersCount < ltScore.followersCount.$lt ||
            (d.followersCount === eqScoreLtId.followersCount && d._id < eqScoreLtId._id.$lt)
          );
        })
      : ranked;
    let limitN = matched.length;
    const chain = {
      sort() {
        return this;
      },
      limit(n: number) {
        limitN = n;
        return this;
      },
      select() {
        return this;
      },
      lean: async () => matched.slice(0, limitN),
    };
    return chain;
  };
  (User as any).countDocuments = async () => docs.length;

  try {
    await fn();
  } finally {
    (User as any).find = originalFind;
    (User as any).countDocuments = originalCountDocuments;
  }
};

test("FR-2 (phân trang, end-to-end): 3 trang liên tiếp qua nextCursor -> không trùng/thiếu record, trang cuối nextCursor=null", async () => {
  await withSitemapSecret(async () => {
    await withStubbedUserFind(FAKE_ELIGIBLE_USER_DOCS, async () => {
      await withServer(sitemapEligibleUsersApp(), async (base) => {
        const authHeaders = { [SITEMAP_SECRET_HEADER]: SITEMAP_SECRET };
        const seenIds: string[] = [];
        let cursor: string | null = null;
        let totalCountFromFirstPage: number | null = null;
        let pageCount = 0;

        do {
          const url = new URL(`${base}/users/sitemap-eligible`);
          url.searchParams.set("limit", "10");
          if (cursor) url.searchParams.set("cursor", cursor);

          const res = await fetch(url, { headers: authHeaders });
          assert.equal(res.status, 200);
          const body: any = await res.json();
          const { data, nextCursor, totalCount } = body.metadata;

          if (pageCount === 0) {
            totalCountFromFirstPage = totalCount;
            assert.equal(totalCount, 25, "totalCount trang đầu phải khớp tổng số record");
          } else {
            assert.equal(totalCount, null, "totalCount CHỈ trả ở trang đầu, các trang sau phải null");
          }

          for (const item of data) {
            assert.ok(
              !seenIds.includes(item.userId),
              `record trùng lặp qua các trang: ${item.userId}`,
            );
            assert.equal(
              Object.prototype.hasOwnProperty.call(item, "followersCount"),
              false,
              "response contract task 003 CHỈ có {userId, updatedAt}, KHÔNG lộ followersCount",
            );
            seenIds.push(item.userId);
          }

          cursor = nextCursor;
          pageCount += 1;
        } while (cursor);

        assert.equal(pageCount, 3, "25 record / limit 10 -> đúng 3 trang");
        assert.equal(seenIds.length, totalCountFromFirstPage, "không được thiếu record nào so với totalCount");
        assert.deepEqual(
          seenIds,
          // followersCount giảm dần -> thứ tự NGƯỢC LẠI với mảng tạo sẵn (vốn tăng dần theo index).
          [...FAKE_ELIGIBLE_USER_DOCS].reverse().map((d) => d._id),
          "thứ tự + tập hợp record phải khớp chính xác, không trùng không thiếu",
        );
      });
    });
  });
});

// Rủi ro cụ thể ghi trong Key risk của epic + Technical Details task 003: nếu SITEMAP_ELIGIBLE lỡ
// đăng ký SAU PROFILE ("/:userId"), Express sẽ match PROFILE trước (cùng 1 segment) -> route này
// biến mất, luôn bị coi là 1 lookup userId. Test này dùng `userRouter` THẬT (có cả PROFILE) để bắt
// đúng lớp bug đó — app tối giản ở trên không có PROFILE nên không test được rủi ro này.
test("FR-2 (route-shadowing regression): GET /users/sitemap-eligible qua router THẬT không bị PROFILE ('/:userId') nuốt", async () => {
  await withSitemapSecret(async () => {
    await withStubbedUserFind(FAKE_ELIGIBLE_USER_DOCS, async () => {
      await withServer(mountUserRouter(), async (base) => {
        const res = await fetch(`${base}/users/sitemap-eligible`, {
          headers: { [SITEMAP_SECRET_HEADER]: SITEMAP_SECRET },
        });
        assert.equal(res.status, 200);
        const body: any = await res.json();
        assert.ok(
          Array.isArray(body.metadata?.data),
          "phải trả về metadata.data dạng mảng (getSitemapEligibleUsers) — nếu bị PROFILE nuốt, response sẽ không có shape này",
        );
        assert.equal(body.metadata.data.length, 25);
        assert.notEqual(
          body.message,
          VALIDATION_ERROR_MESSAGE,
          "không được rơi vào getUserProfileSchema (params.userId ObjectId) của route PROFILE",
        );
      });
    });
  });
});

test("FR-2 (wiring, source): SITEMAP_ELIGIBLE có sitemapAuthGate + validate(getSitemapEligibleUsersQuerySchema), đăng ký TRƯỚC PROFILE", async () => {
  const src = await readFile("src/api/routers/user.route.ts", "utf8");
  const noComments = src.replace(/^\s*\/\/.*$/gm, "");

  // KHÔNG rate limiter — xem lý do đầy đủ ở post.route.test.ts (sibling route task 002) /
  // rateLimiter.ts: mọi ngưỡng theo-phút đều fail khi Next.js's static export gọi getChunk() đồng
  // thời cho nhiều chunk lúc build.
  assert.ok(
    noComments.includes(
      "router.get(\n  SITEMAP_ELIGIBLE,\n  sitemapAuthGate,\n  validate(getSitemapEligibleUsersQuerySchema),\n  asyncHandler(getSitemapEligibleUsers),\n);",
    ),
    "route SITEMAP_ELIGIBLE phải wire đúng 3 middleware theo đúng thứ tự này",
  );

  const idxProfile = noComments.indexOf("router.get(\n  PROFILE,");
  const idxSitemapEligible = noComments.indexOf("router.get(\n  SITEMAP_ELIGIBLE,");
  assert.ok(idxSitemapEligible >= 0 && idxProfile >= 0);
  assert.ok(
    idxSitemapEligible < idxProfile,
    "SITEMAP_ELIGIBLE (literal 1-segment) phải đăng ký TRƯỚC PROFILE, nếu không sẽ bị nuốt",
  );
});
