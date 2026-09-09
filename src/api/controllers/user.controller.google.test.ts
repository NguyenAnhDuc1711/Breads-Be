import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import mongoose from "mongoose";
import { Constants } from "../../Breads-Shared/Constants/index.js";
import User from "../models/user.model.ts";
import { googleLoginWith } from "./user.controller.ts";

const MONGO_PORT = 49_200 + (process.pid % 500);
const DB_NAME = "breads_googlelogin_test";

const SUB = "google-sub-primary";
const OTHER_SUB = "google-sub-other";
const EMAIL = "gina.doe@example.com";

let mongod: ChildProcess | null = null;
let dbPath = "";

/**
 * `res` giả: ghi lại cookie đã set để test khẳng định được "KHÔNG có Set-Cookie: refreshToken"
 * — cấp session rồi mới báo lỗi vẫn là lỗ hổng, nên chỉ khẳng định "có ném lỗi" là chưa đủ.
 */
const buildRes = () =>
  ({
    cookies: {} as Record<string, unknown>,
    status(code: number) {
      this._status = code;
      return this;
    },
    json(body: any) {
      this._body = body;
      return this;
    },
    cookie(name: string, value: string, options: any) {
      this.cookies[name] = { value, options };
      return this;
    },
  }) as any;

const profileOf = (overrides: Record<string, unknown> = {}) => ({
  sub: SUB,
  email: EMAIL,
  emailVerified: true,
  name: "Gina Doe",
  picture: "https://lh3.googleusercontent.com/gina",
  ...overrides,
});

/** Hàm xác thực token tiêm vào controller: id_token Google thật không ký lại được ngoại tuyến. */
const depsReturning = (profile: any, seenTokens: string[] = []) => ({
  verifyIdToken: async (idToken: string) => {
    seenTokens.push(idToken);
    return profile;
  },
});

before(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
  process.env.COOKIE_SECURE = "false";

  dbPath = mkdtempSync(join(tmpdir(), "breads-googlelogin-"));
  mongod = spawn(
    "mongod",
    ["--dbpath", dbPath, "--port", String(MONGO_PORT), "--bind_ip", "127.0.0.1"],
    { stdio: "ignore" },
  );
  mongod.on("error", () => {
    /* lỗi spawn hiện ra qua timeout kết nối bên dưới, kèm hướng dẫn rõ ràng */
  });

  const uri = `mongodb://127.0.0.1:${MONGO_PORT}/${DB_NAME}`;
  const deadline = Date.now() + 30_000;
  let connected = false;
  while (Date.now() < deadline) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 1000 });
      connected = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  assert.ok(
    connected,
    `Không kết nối được MongoDB tạm ở ${uri}. Test này cần binary \`mongod\` trên PATH ` +
      `(macOS: \`brew install mongodb-community\`) — KHÔNG được skip nó.`,
  );

  await User.syncIndexes();
});

after(async () => {
  await mongoose.disconnect().catch(() => {});
  mongod?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  if (dbPath) rmSync(dbPath, { recursive: true, force: true });
});

beforeEach(async () => {
  await User.deleteMany({});
  await mongoose.connection.collection("refreshtokens").deleteMany({});
});

test("#6 FR-3: emailVerified=false -> từ chối, 0 user được tạo, 0 cookie", async () => {
  const res = buildRes();

  await assert.rejects(
    () =>
      googleLoginWith(
        { body: { idToken: "tok" } },
        res,
        depsReturning(profileOf({ emailVerified: false })),
      ),
    /chưa được xác thực/,
  );

  assert.equal(await User.countDocuments({}), 0, "không được tạo user");
  assert.deepEqual(res.cookies, {}, "không được set cookie nào");
  assert.equal(res._status, undefined, "không được gửi response thành công");
});

test("#7 FR-2.5: client gửi kèm email/name/avatar khác payload -> lấy theo payload", async () => {
  const res = buildRes();
  const seenTokens: string[] = [];

  await googleLoginWith(
    {
      body: {
        idToken: "tok",
        email: "attacker@evil.com",
        name: "Attacker",
        avatar: "https://evil.com/a.png",
        role: Constants.USER_ROLE.ADMIN,
        status: Constants.USER_STATUS.BANNED,
      },
    },
    res,
    depsReturning(profileOf(), seenTokens),
  );

  assert.deepEqual(seenTokens, ["tok"]);
  const created = await User.findOne({});
  assert.equal(created!.email, EMAIL, "email phải theo payload đã xác thực");
  assert.equal(created!.name, "Gina Doe");
  assert.equal(created!.avatar, "https://lh3.googleusercontent.com/gina");
  assert.equal(created!.role, Constants.USER_ROLE.USER, "role client gửi bị bỏ qua");
  assert.equal(created!.status, Constants.USER_STATUS.ACTIVE, "status client gửi bị bỏ qua");
});

test("#8 FR-4 tổ hợp 1: tạo đúng 1 user, googleId=sub, không có password, ACTIVE", async () => {
  const res = buildRes();

  await googleLoginWith({ body: { idToken: "tok" } }, res, depsReturning(profileOf()));

  assert.equal(await User.countDocuments({}), 1);
  const created = await User.findOne({});
  assert.equal(created!.googleId, SUB);
  assert.equal(created!.password, undefined, "tài khoản Google không có password");
  assert.equal(created!.status, Constants.USER_STATUS.ACTIVE);
  assert.match(created!.username, /^[a-z0-9._-]{3,30}$/);
  assert.equal(res._status, 200);
  assert.ok(res._body.metadata.accessToken, "phải cấp accessToken");
  assert.ok(res.cookies.refreshToken, "phải set cookie refreshToken (FR-9)");
});

test("#9 FR-6 tổ hợp 2: gộp -> _id không đổi, password/username/avatar/bio nguyên vẹn", async () => {
  const legacy = await User.create({
    name: "Legacy Gina",
    username: "legacy_gina",
    email: EMAIL,
    password: "hashed-password-value",
    avatar: "https://cdn.breads/legacy.png",
    bio: "bio cũ",
  });

  const res = buildRes();
  await googleLoginWith({ body: { idToken: "tok" } }, res, depsReturning(profileOf()));

  assert.equal(await User.countDocuments({}), 1, "số lượng user không được tăng");
  const merged = await User.findById(legacy._id);
  assert.ok(merged, "_id phải giữ nguyên");
  assert.equal(merged!.googleId, SUB);
  assert.equal(merged!.password, "hashed-password-value");
  assert.equal(merged!.username, "legacy_gina");
  assert.equal(merged!.avatar, "https://cdn.breads/legacy.png");
  assert.equal(merged!.bio, "bio cũ");
  assert.equal(res._status, 200);
});

test("#10 FR-7 tổ hợp 3: đăng nhập lần 2 -> số user không tăng, email cũ KHÔNG bị ghi đè", async () => {
  const first = buildRes();
  await googleLoginWith({ body: { idToken: "tok" } }, first, depsReturning(profileOf()));
  const createdId = String((await User.findOne({}))!._id);

  // Người dùng đổi email bên Google: cùng sub, email mới.
  const second = buildRes();
  await googleLoginWith(
    { body: { idToken: "tok2" } },
    second,
    depsReturning(profileOf({ email: "gina.new@example.com" })),
  );

  assert.equal(await User.countDocuments({}), 1, "không được tạo tài khoản trùng");
  const user = await User.findOne({});
  assert.equal(String(user!._id), createdId, "phải vào đúng tài khoản cũ");
  assert.equal(user!.email, EMAIL, "email lưu trong hệ thống không bị ghi đè");
  assert.equal(second._status, 200);
});

test("#11 FR-11 tổ hợp 4: email khớp user đã gắn googleId khác -> từ chối, googleId cũ nguyên vẹn", async () => {
  const owner = await User.create({
    name: "Owner",
    username: "owner_acct",
    email: EMAIL,
    googleId: OTHER_SUB,
  });

  const res = buildRes();
  await assert.rejects(
    () => googleLoginWith({ body: { idToken: "tok" } }, res, depsReturning(profileOf())),
    /tài khoản Google khác/,
  );

  const unchanged = await User.findById(owner._id);
  assert.equal(unchanged!.googleId, OTHER_SUB, "googleId cũ không được ghi đè");
  assert.equal(await User.countDocuments({}), 1, "không được tạo user mới");
  assert.deepEqual(res.cookies, {}, "không được cấp session");
  assert.equal(res._status, undefined);
});

test("#12 FR-8: tài khoản BANNED -> từ chối và KHÔNG có Set-Cookie: refreshToken", async () => {
  await User.create({
    name: "Banned",
    username: "banned_user",
    email: EMAIL,
    googleId: SUB,
    status: Constants.USER_STATUS.BANNED,
    statusReason: "spam",
  });

  const res = buildRes();
  await assert.rejects(
    () => googleLoginWith({ body: { idToken: "tok" } }, res, depsReturning(profileOf())),
    /Tài khoản đang bị hạn chế/,
  );

  assert.equal(
    res.cookies.refreshToken,
    undefined,
    "KHÔNG được set cookie refreshToken cho tài khoản bị cấm",
  );
  assert.equal(
    await mongoose.connection.collection("refreshtokens").countDocuments({}),
    0,
    "không được lưu refresh token nào",
  );
});

test("#13 RISK-2: E11000 trên email ở nhánh create -> chuyển sang login, không phải 500", async () => {
  const originalCreate = (User as any).create;
  let racedId = "";

  // Giả lập request song song: ngay trước khi ta ghi, request kia đã ghi xong bản ghi cùng email.
  (User as any).create = async (doc: any) => {
    (User as any).create = originalCreate; // chỉ chen ngang đúng một lần
    const raced = await originalCreate.call(User, {
      ...doc,
      username: `${doc.username}-raced`,
    });
    racedId = String(raced._id);
    const err: any = new Error(
      "E11000 duplicate key error collection: users index: email_1",
    );
    err.code = 11000;
    err.keyPattern = { email: 1 };
    err.keyValue = { email: doc.email };
    throw err;
  };

  const res = buildRes();
  try {
    await googleLoginWith({ body: { idToken: "tok" } }, res, depsReturning(profileOf()));
  } finally {
    (User as any).create = originalCreate;
  }

  assert.equal(res._status, 200, "race không được biến thành lỗi 500");
  assert.equal(String(res._body.metadata._id), racedId, "đăng nhập vào bản ghi của request kia");
  assert.equal(await User.countDocuments({}), 1, "không được tạo bản ghi trùng");
  assert.ok(res.cookies.refreshToken, "session vẫn được cấp bình thường");
});
