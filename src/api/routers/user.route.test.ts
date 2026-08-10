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
  signupUserSchema,
  loginUserSchema,
  followUserSchema,
  updateUserSchema,
  changePasswordSchema,
  validateEmailByCodeSchema,
} from "../validators/user.validator.ts";
import userRouter from "./user.route.ts";
import { VALIDATION_ERROR_MESSAGE } from "../middlewares/validate.ts";

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
