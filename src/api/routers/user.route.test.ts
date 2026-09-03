import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { z } from "zod";
import { Constants } from "../../Breads-Shared/Constants/index.js";
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
  getSitemapEligibleUsersQuerySchema,
  requestPasswordResetSchema,
  verifyPasswordResetCodeSchema,
  confirmPasswordResetSchema,
} from "../validators/user.validator.ts";
import userRouter from "./user.route.ts";
import { VALIDATION_ERROR_MESSAGE, validate } from "../middlewares/validate.ts";
import { getSitemapEligibleUsers } from "../controllers/user.controller.ts";
import sitemapAuthGate, {
  SITEMAP_SECRET_HEADER,
} from "../middlewares/sitemapAuthGate.ts";
import asyncHandler from "../../helpers/asyncHandler.ts";
import User from "../models/user.model.ts";
import Post from "../models/post.model.ts";

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

test("followUserSchema: chỉ {userFlId} là đủ — userId gửi kèm bị strip", () => {
  assert.deepEqual(followUserSchema.body.parse({ userFlId: VALID_OBJECT_ID }), {
    userFlId: VALID_OBJECT_ID,
  });
  const parsed: any = followUserSchema.body.parse({
    userFlId: VALID_OBJECT_ID,
    userId: VALID_OBJECT_ID_2,
  });
  assert.equal(parsed.userId, undefined, "userId do client gửi phải bị strip");
});

test("followUserSchema: thiếu userFlId fail", () => {
  assert.throws(
    () => followUserSchema.body.parse({ userId: VALID_OBJECT_ID_2 }),
    z.ZodError
  );
});

test("followUserSchema: userFlId không phải ObjectId fail", () => {
  assert.throws(
    () => followUserSchema.body.parse({ userFlId: "not-an-id" }),
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

test("changePasswordSchema: chỉ forgotPW: true (không currentPW/newPW) bị REJECT", () => {
  assert.throws(() => changePasswordSchema.body.parse({ forgotPW: true }), z.ZodError);
});

test("changePasswordSchema: forgotPW bị strip khỏi payload hợp lệ (không tới được controller)", () => {
  const parsed = changePasswordSchema.body.parse({
    currentPW: "old-secret",
    newPW: "new-secret",
    forgotPW: true,
  });
  assert.deepEqual(parsed, { currentPW: "old-secret", newPW: "new-secret" });
});

test("changePasswordSchema: newPW ngắn hơn 6 ký tự bị REJECT", () => {
  assert.throws(
    () => changePasswordSchema.body.parse({ currentPW: "old-secret", newPW: "12345" }),
    z.ZodError
  );
});

test("requestPasswordResetSchema: chỉ nhận email — userId client gửi kèm bị strip", () => {
  const parsed = requestPasswordResetSchema.body.parse({
    email: "duc@example.com",
    userId: VALID_OBJECT_ID,
  });
  assert.deepEqual(parsed, { email: "duc@example.com" });
});

test("verifyPasswordResetCodeSchema: mã khác 6 ký tự bị REJECT", () => {
  assert.throws(
    () => verifyPasswordResetCodeSchema.body.parse({ email: "duc@example.com", code: "123" }),
    z.ZodError
  );
});

test("confirmPasswordResetSchema: {userId, code, newPW} hợp lệ pass", () => {
  assert.doesNotThrow(() =>
    confirmPasswordResetSchema.body.parse({
      userId: VALID_OBJECT_ID,
      code: "A1b2C3",
      newPW: "new-secret",
    })
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

test("getUsersPendingPostSchema: limit=1000 KHÔNG bị chặn (cap .max(50) của getUsersFollow không leak sang route body này)", () => {
  assert.doesNotThrow(() =>
    getUsersPendingPostSchema.body.parse({
      userId: VALID_OBJECT_ID,
      page: 1,
      limit: 1000,
    })
  );
});

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


test("FR-2 (D-1): user.route.ts wiring khớp đúng 22 (method, path) mới, đúng thứ tự chống shadow route động", () => {
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
    { method: "get", path: "/:id/admin-detail" },
    { method: "get", path: "/sitemap-eligible" },
    { method: "get", path: "/:userId" },
    { method: "post", path: "/pending-post-lookup" },
    { method: "post", path: "/" },
    { method: "post", path: "/sessions" },
    { method: "post", path: "/sessions/logout" },
    { method: "post", path: "/sessions/refresh" },
    { method: "put", path: "/follow" },
    { method: "put", path: "/:id" },
    { method: "put", path: "/:id/admin-action" },
    { method: "put", path: "/:id/password" },
    { method: "post", path: "/password-reset/requests" },
    { method: "post", path: "/password-reset/verify" },
    { method: "post", path: "/password-reset/confirm" },
    { method: "post", path: "/crawl" },
    { method: "post", path: "/email-validations" },
  ];

  assert.equal(routes.length, 22, "phải có đúng 22 route đăng ký trên router");
  assert.deepEqual(
    routes,
    expected,
    "method+path (và thứ tự đăng ký) phải khớp đúng bảng redesign 010.md + SITEMAP_ELIGIBLE task 003 + admin-detail/admin-action (Users module), trừ backdoor GET /admin đã gỡ"
  );
});

const SITEMAP_SECRET = "test-sitemap-secret";

const withSitemapSecret = async (fn: () => Promise<void> | void) => {
  process.env.SITEMAP_SHARED_SECRET = SITEMAP_SECRET;
  try {
    await fn();
  } finally {
    delete process.env.SITEMAP_SHARED_SECRET;
  }
};

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

const FAKE_ELIGIBLE_USER_DOCS = Array.from({ length: 25 }, (_, i) => ({
  _id: String(i + 1).padStart(24, "0"),
  updatedAt: new Date(2024, 0, i + 1),
  followersCount: 10 + i,
}));

const withStubbedUserFind = async (
  docs: typeof FAKE_ELIGIBLE_USER_DOCS,
  fn: () => Promise<void> | void,
) => {
  const originalFind = (User as any).find;
  const originalCountDocuments = (User as any).countDocuments;

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
          [...FAKE_ELIGIBLE_USER_DOCS].reverse().map((d) => d._id),
          "thứ tự + tập hợp record phải khớp chính xác, không trùng không thiếu",
        );
      });
    });
  });
});

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

process.env.JWT_SECRET = process.env.JWT_SECRET || "user-route-test-secret";

const PENDING_POST_VIEWER_ID = "652f1b2c3d4e5f6071829310";
const pendingPostAuthToken = jwt.sign(
  { userId: PENDING_POST_VIEWER_ID },
  process.env.JWT_SECRET,
);

const withStubbedPendingPostModels = async (
  role: number,
  fn: () => Promise<void>,
) => {
  const originalFindById = (User as any).findById;
  const originalFindOne = (User as any).findOne;
  const originalUserFind = (User as any).find;
  const originalPostFind = (Post as any).find;

  (User as any).findById = () => ({
    select: () =>
      Promise.resolve({
        _id: new mongoose.Types.ObjectId(PENDING_POST_VIEWER_ID),
        role,
        lastActiveAt: new Date(),
      }),
  });
  (User as any).findOne = async () => ({ role });
  (Post as any).find = () => ({ lean: () => Promise.resolve([]) });
  const userFindChain: any = {
    skip() {
      return this;
    },
    limit() {
      return this;
    },
    then(resolve: any) {
      resolve([]);
    },
  };
  (User as any).find = () => userFindChain;

  try {
    await fn();
  } finally {
    (User as any).findById = originalFindById;
    (User as any).findOne = originalFindOne;
    (User as any).find = originalUserFind;
    (Post as any).find = originalPostFind;
  }
};

test("Task 009: POST /users/pending-post-lookup role=MODERATOR (jwt) -> 200, không cần userId trong body", async () => {
  await withStubbedPendingPostModels(Constants.USER_ROLE.MODERATOR, async () => {
    await withServer(mountUserRouter(), async (base) => {
      const res = await fetch(`${base}/users/pending-post-lookup`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${pendingPostAuthToken}`,
        },
        body: JSON.stringify({ page: 1, limit: 20 }),
      });
      assert.equal(res.status, 200, "MODERATOR (trước đây bị 403 do bug pattern ADMIN-only) phải qua được");
    });
  });
});

test("Task 009 (auth-gap fix): POST /users/pending-post-lookup không có JWT -> 401, kể cả gửi userId giả mạo trong body", async () => {
  await withStubbedPendingPostModels(Constants.USER_ROLE.ADMIN, async () => {
    await withServer(mountUserRouter(), async (base) => {
      const res = await fetch(`${base}/users/pending-post-lookup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: PENDING_POST_VIEWER_ID, page: 1, limit: 20 }),
      });
      assert.equal(res.status, 401);
    });
  });
});

test("getUsersPendingPostSchema: body không còn nhận/yêu cầu userId", () => {
  const parsed: any = getUsersPendingPostSchema.body.parse({ page: 1, limit: 20 });
  assert.equal((parsed as any).userId, undefined, "userId phải bị strip/không tồn tại trong schema");
});

test("Bước 6: 2 endpoint dò tài khoản không được khôi phục", async () => {
  const routeSrc = await readFile("src/api/routers/user.route.ts", "utf8");
  const code = routeSrc.replace(/^\s*\/\/.*$/gm, "");
  for (const gone of ["CHECK_VALID_USER", "GET_USER_ID_FROM_EMAIL"]) {
    assert.ok(!code.includes(gone), `${gone} không được xuất hiện lại trong user.route.ts`);
  }

  const configSrc = await readFile("src/Breads-Shared/APIConfig.ts", "utf8");
  const configCode = configSrc.replace(/^\s*\/\/.*$/gm, "");
  assert.ok(
    !configCode.includes("validity-checks") && !configCode.includes("id-lookup"),
    "constant của 2 endpoint đã xoá không được còn trong APIConfig"
  );
});
