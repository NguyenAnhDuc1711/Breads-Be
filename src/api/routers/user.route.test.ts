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
} from "../validators/user.validator.ts";
import userRouter from "./user.route.ts";
import { VALIDATION_ERROR_MESSAGE, validate } from "../middlewares/validate.ts";

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
    const res = await fetch(`${base}/users/signup`, {
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
    const res = await fetch(`${base}/users/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "not-an-email", password: "x" }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
  });
});

test("FR-4 (ObjectId param): GET /users/profile/not-an-id -> 400 trước khi getUserProfile chạy", async () => {
  await withServer(mountUserRouter(), async (base) => {
    const res = await fetch(`${base}/users/profile/not-an-id`);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
  });
});

test("FR-4 (no-schema route): POST /users/logout không đổi hành vi — vẫn 200 bất kể body", async () => {
  await withServer(mountUserRouter(), async (base) => {
    const res = await fetch(`${base}/users/logout`, {
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
// Lưu ý: `getAdminAccount` (User.findOne) và `handleCrawlFakeUsers` (crawlUser) đều chạm DB/mạng
// thật ngay cả khi input hợp lệ (route không có schema nên validate() không chặn được gì trước đó)
// — theo đúng rule ở đầu file, KHÔNG test 2 route này qua tầng HTTP; "không có validate() chen
// vào" cho 2 route này được xác nhận qua code review + checklist `grep -c "validate("` thủ công.

test("FR-4 (pagination cap, local): GET /users/users-follow?limit=1000 -> 400 (vượt cap .max(50))", async () => {
  await withServer(mountUserRouter(), async (base) => {
    const res = await fetch(
      `${base}/users/users-follow?userId=${VALID_OBJECT_ID}&type=following&limit=1000`
    );
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
  });
});

test("FR-4 (type enum): GET /users/users-follow?type=bogus -> 400 trước khi getUsersFollow chạy", async () => {
  await withServer(mountUserRouter(), async (base) => {
    const res = await fetch(
      `${base}/users/users-follow?userId=${VALID_OBJECT_ID}&type=bogus`
    );
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
  });
});

test("FR-4 (checkValidUser, body rỗng): POST /users/check-valid-user với body {} -> KHÔNG phải lỗi validate (either-or vẫn là controller kiểm, throw sớm trước khi chạm DB)", async () => {
  await withServer(mountUserRouter(), async (base) => {
    const res = await fetch(`${base}/users/check-valid-user`, {
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

  await withServer(mountEcho("post", "/users/signup", signupUserSchema), async (base) => {
    const res = await fetch(`${base}/users/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { body: Record<string, unknown> };
    assert.deepEqual(json.body, payload, "reassignment không được làm rơi/đổi field nào");
  });
});

test("NFR-4 (positive, query): users-follow query hợp lệ chạm controller, page/limit coerce đúng kiểu", async () => {
  await withServer(
    mountEcho("get", "/users/users-follow", getUsersFollowQuerySchema),
    async (base) => {
      const res = await fetch(
        `${base}/users/users-follow?userId=${VALID_OBJECT_ID}&type=following&page=2&limit=50`
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

test("NFR-4 (positive, params): GET /users/profile/:userId với ObjectId hợp lệ chạm controller", async () => {
  await withServer(
    mountEcho("get", "/users/profile/:userId", getUserProfileSchema),
    async (base) => {
      const res = await fetch(`${base}/users/profile/${VALID_OBJECT_ID}`);
      assert.equal(res.status, 200);
      const json = (await res.json()) as { params: Record<string, unknown> };
      assert.deepEqual(json.params, { userId: VALID_OBJECT_ID });
    }
  );
});

test("FR-4 (getUserIdFromEmail): thiếu userEmail -> 400 trước khi controller chạy", async () => {
  await withServer(mountUserRouter(), async (base) => {
    const res = await fetch(`${base}/users/get-user-id-from-email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
  });
});
