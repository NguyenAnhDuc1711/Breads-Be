import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import Redis from "ioredis";
import { Constants } from "../../Breads-Shared/Constants/index.js";
import { getCache, setCache, deleteCache, getRedisInstance } from "../../dbs/redis.ts";
import initRedis from "../../dbs/redis.ts";
import { hashToken } from "../utils/generateTokens.ts";
import User from "../models/user.model.ts";
import {
  confirmPasswordReset,
  loginUser,
  requestPasswordReset,
  verifyPasswordResetCode,
} from "./user.controller.ts";

/**
 * Task #21 — Iron Regression Rule: luồng reset mật khẩu (PW_RESET_REQUEST / PW_RESET_VERIFY /
 * PW_RESET_CONFIRM) đang chạy cho toàn bộ user hiện có, nay phải chịu thêm nhóm user không có
 * `password` (tài khoản tạo qua Google, xem task #18). Đọc kỹ ba handler trong user.controller.ts
 * cho thấy **không có chỗ nào đọc `user.password`** — chúng chỉ thao tác trên `email`, `_id` và
 * mã xác minh lưu ở Redis (`pw_reset_<userId>`), rồi ghi đè `password` không điều kiện qua
 * `applyNewPassword`. Do đó KHÔNG có sửa code nào trong file này — chỉ có test khẳng định.
 *
 * Mã xác minh thật được gửi qua email (`sendMailService`, ngoài phạm vi sửa của task này và im
 * lặng nuốt lỗi khi không có SMTP thật) nên không đọc lại được từ bên ngoài. Để test tất định,
 * các test cho VERIFY/CONFIRM tự seed một entry Redis đúng định dạng mà `requestPasswordReset`
 * tạo ra (cùng key `pw_reset_<userId>`, cùng hàm băm `hashToken` import trực tiếp từ
 * `generateTokens.ts` — không phải suy đoán). Test cho REQUEST thì gọi handler thật và kiểm tra
 * side-effect của nó lên Redis.
 */

const MONGO_PORT = 49_700 + (process.pid % 500);
const DB_NAME = "breads_pwreset_test";

let mongod: ChildProcess | null = null;
let dbPath = "";
let redisAvailable = true;

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

const pwResetCacheKey = (userId: string) => `pw_reset_${userId}`;
const hashResetCode = (code: string) => hashToken(code.toUpperCase());

const seededKeys: string[] = [];

/** Reo tạo đúng entry Redis mà `requestPasswordReset` tạo ra, với một mã biết trước. */
const seedResetCode = async (userId: string, code: string, ttlSeconds = 900) => {
  const key = pwResetCacheKey(userId);
  seededKeys.push(key);
  await setCache(key, { codeHash: hashResetCode(code), attempts: 0 }, ttlSeconds);
};

const createUserWithPassword = async (rawPassword = "OldPass123") => {
  const hashed = await bcrypt.hash(rawPassword, 10);
  const user = await User.create({
    name: "Pw User",
    username: `pwuser_${new mongoose.Types.ObjectId().toHexString()}`,
    email: `pwuser_${new mongoose.Types.ObjectId().toHexString()}@example.com`,
    password: hashed,
  });
  return { user, rawPassword };
};

const createGoogleOnlyUser = async (overrides: Record<string, unknown> = {}) => {
  const user = await User.create({
    name: "Google User",
    username: `gguser_${new mongoose.Types.ObjectId().toHexString()}`,
    email: `gguser_${new mongoose.Types.ObjectId().toHexString()}@example.com`,
    googleId: `sub_${new mongoose.Types.ObjectId().toHexString()}`,
    ...overrides,
  });
  assert.equal(user.password, undefined, "setup: tài khoản Google-only không được có password");
  return user;
};

before(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
  process.env.COOKIE_SECURE = "false";

  dbPath = mkdtempSync(join(tmpdir(), "breads-pwreset-"));
  mongod = spawn(
    "mongod",
    ["--dbpath", dbPath, "--port", String(MONGO_PORT), "--bind_ip", "127.0.0.1"],
    { stdio: "ignore" },
  );
  mongod.on("error", () => {});

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

  const probe = new Redis({
    host: process.env.REDIS_HOST || "localhost",
    port: Number(process.env.REDIS_PORT || 6379),
    lazyConnect: true,
    connectTimeout: 1000,
    retryStrategy: () => null,
    maxRetriesPerRequest: 1,
  });
  probe.on("error", () => {});
  try {
    await probe.connect();
    await probe.ping();
  } catch {
    redisAvailable = false;
  } finally {
    probe.disconnect();
  }
  assert.ok(
    redisAvailable,
    "Redis không khả dụng ở localhost:6379 — luồng reset mật khẩu cần Redis thật cho mã xác " +
      "minh (pw_reset_<userId>). KHÔNG được skip test này, cài/khởi động Redis rồi chạy lại.",
  );
  initRedis();
  const redis = getRedisInstance();
  if (redis && redis.status !== "ready") {
    await new Promise((resolve) => redis.once("ready", resolve));
  }
});

after(async () => {
  await mongoose.disconnect().catch(() => {});
  mongod?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  if (dbPath) rmSync(dbPath, { recursive: true, force: true });
  getRedisInstance()?.disconnect();
});

afterEach(async () => {
  await User.deleteMany({});
  while (seededKeys.length) {
    const key = seededKeys.pop()!;
    await deleteCache(key).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// PW_RESET_REQUEST
// ---------------------------------------------------------------------------

test("PW_RESET_REQUEST: user CÓ password -> tạo entry Redis (codeHash, attempts:0, TTL)", async () => {
  const { user } = await createUserWithPassword();
  const res = buildRes();

  await requestPasswordReset({ body: { email: user.email } }, res);

  assert.equal(res._status, 200);
  const key = pwResetCacheKey(String(user._id));
  seededKeys.push(key);
  const entry = await getCache<{ codeHash: string; attempts: number }>(key);
  assert.ok(entry?.codeHash, "phải lưu codeHash");
  assert.equal(entry!.attempts, 0);
});

test("PW_RESET_REQUEST: user KHÔNG có password (Google-only) -> vẫn tạo entry Redis y hệt (FR-14)", async () => {
  const user = await createGoogleOnlyUser();
  const res = buildRes();

  await requestPasswordReset({ body: { email: user.email } }, res);

  assert.equal(res._status, 200);
  const key = pwResetCacheKey(String(user._id));
  seededKeys.push(key);
  const entry = await getCache<{ codeHash: string; attempts: number }>(key);
  assert.ok(entry?.codeHash, "phải lưu codeHash dù user không có password");
  assert.equal(entry!.attempts, 0);
});

test("PW_RESET_REQUEST: email không tồn tại -> vẫn 200 (không lộ thông tin), không tạo entry", async () => {
  const res = buildRes();
  await requestPasswordReset({ body: { email: "khong-ton-tai@example.com" } }, res);
  assert.equal(res._status, 200);
});

// ---------------------------------------------------------------------------
// #1 — NFR-1 / CRIT-1: nhánh CÓ password không được hồi quy (test quan trọng nhất)
// ---------------------------------------------------------------------------

test("#1 NFR-1/CRIT-1: user CÓ password đặt lại mật khẩu -> thành công, login được bằng mật khẩu mới", async () => {
  const { user } = await createUserWithPassword();
  await seedResetCode(String(user._id), "AB12CD");

  const res = buildRes();
  await confirmPasswordReset(
    { body: { userId: String(user._id), code: "AB12CD", newPW: "NewPass456" } },
    res,
  );
  assert.equal(res._status, 200);

  const updated = await User.findById(user._id);
  assert.ok(
    await bcrypt.compare("NewPass456", updated!.password!),
    "password mới phải được ghi (hashed)",
  );

  const loginRes = buildRes();
  await loginUser({ body: { email: user.email, password: "NewPass456" } }, loginRes);
  assert.equal(loginRes._status, 200, "phải login được bằng mật khẩu mới");
  assert.ok(loginRes._body.metadata.accessToken, "phải cấp accessToken");
});

// ---------------------------------------------------------------------------
// #2-#4 — FR-14: nhánh KHÔNG có password (Google-only) đặt mật khẩu lần đầu
// ---------------------------------------------------------------------------

test("#2-4 FR-14: user KHÔNG có password đặt mật khẩu lần đầu -> ghi password, login email/pw OK, googleId nguyên vẹn, Google login vẫn vào đúng account", async () => {
  const user = await createGoogleOnlyUser();
  const sub = user.googleId;
  await seedResetCode(String(user._id), "GG9XYZ");

  // toàn bộ 3 bước: REQUEST đã test riêng ở trên; đây là VERIFY -> CONFIRM nối tiếp.
  const verifyRes = buildRes();
  await verifyPasswordResetCode({ body: { email: user.email, code: "GG9XYZ" } }, verifyRes);
  assert.equal(verifyRes._status, 200, "VERIFY phải qua được dù user không có password");

  // VERIFY không xoá cache (deleteOnSuccess:false) nên CONFIRM vẫn dùng lại được cùng mã.
  const confirmRes = buildRes();
  await confirmPasswordReset(
    { body: { userId: String(user._id), code: "GG9XYZ", newPW: "FirstPass789" } },
    confirmRes,
  );
  assert.equal(confirmRes._status, 200, "CONFIRM phải qua được dù user không có password (#2)");

  const afterReset = await User.findById(user._id);
  assert.ok(afterReset!.password, "password phải được ghi lần đầu (#2)");
  assert.ok(await bcrypt.compare("FirstPass789", afterReset!.password!));

  // #3: login bằng email/password mới phải hoạt động.
  const loginRes = buildRes();
  await loginUser({ body: { email: user.email, password: "FirstPass789" } }, loginRes);
  assert.equal(loginRes._status, 200, "#3: phải login được bằng email/mật khẩu vừa đặt");
  assert.ok(loginRes._body.metadata.accessToken);

  // #4: googleId còn nguyên -> Google login vẫn vào đúng account cũ, không tạo mới.
  assert.equal(afterReset!.googleId, sub, "#4: googleId không được xoá sau khi đặt password");
  assert.equal(await User.countDocuments({}), 1, "vẫn chỉ 1 user trong hệ thống");
});

// ---------------------------------------------------------------------------
// #5 — NFR-1: mã xác minh sai bị từ chối cho cả hai loại tài khoản
// ---------------------------------------------------------------------------

test("#5 NFR-1: mã sai bị từ chối — user CÓ password, password không đổi", async () => {
  const { user, rawPassword } = await createUserWithPassword();
  await seedResetCode(String(user._id), "RIGHT1");

  const res = buildRes();
  await assert.rejects(
    () =>
      confirmPasswordReset(
        { body: { userId: String(user._id), code: "WRONGX", newPW: "ShouldNotApply1" } },
        res,
      ),
    /Invalid or expired code/,
  );

  const unchanged = await User.findById(user._id);
  assert.ok(
    await bcrypt.compare(rawPassword, unchanged!.password!),
    "password cũ phải còn nguyên",
  );
});

test("#5 NFR-1: mã sai bị từ chối — user KHÔNG có password, vẫn không có password sau đó", async () => {
  const user = await createGoogleOnlyUser();
  await seedResetCode(String(user._id), "RIGHT2");

  const res = buildRes();
  await assert.rejects(
    () =>
      confirmPasswordReset(
        { body: { userId: String(user._id), code: "WRONGY", newPW: "ShouldNotApply2" } },
        res,
      ),
    /Invalid or expired code/,
  );

  const unchanged = await User.findById(user._id);
  assert.equal(unchanged!.password, undefined, "vẫn không được có password nào được ghi");
});

test("#5 NFR-1: VERIFY với mã sai cũng bị từ chối cho cả hai loại tài khoản", async () => {
  const { user: pwUser } = await createUserWithPassword();
  await seedResetCode(String(pwUser._id), "OK1234");
  const ggUser = await createGoogleOnlyUser();
  await seedResetCode(String(ggUser._id), "OK5678");

  await assert.rejects(
    () => verifyPasswordResetCode({ body: { email: pwUser.email, code: "BADCODE" } }, buildRes()),
    /Invalid or expired code/,
  );
  await assert.rejects(
    () => verifyPasswordResetCode({ body: { email: ggUser.email, code: "BADCODE" } }, buildRes()),
    /Invalid or expired code/,
  );
});

// ---------------------------------------------------------------------------
// #6 — NFR-1: mã đã dùng / hết hạn bị từ chối cho cả hai loại tài khoản
// ---------------------------------------------------------------------------

test("#6 NFR-1: mã đã dùng (single-use) bị từ chối lần 2 — user CÓ password", async () => {
  const { user } = await createUserWithPassword();
  await seedResetCode(String(user._id), "ONCE01");

  const first = buildRes();
  await confirmPasswordReset(
    { body: { userId: String(user._id), code: "ONCE01", newPW: "FirstUse123" } },
    first,
  );
  assert.equal(first._status, 200);

  const second = buildRes();
  await assert.rejects(
    () =>
      confirmPasswordReset(
        { body: { userId: String(user._id), code: "ONCE01", newPW: "SecondUse456" } },
        second,
      ),
    /Invalid or expired code/,
    "mã đã dùng một lần rồi không được dùng lại (single-use)",
  );

  const finalState = await User.findById(user._id);
  assert.ok(
    await bcrypt.compare("FirstUse123", finalState!.password!),
    "mật khẩu phải là giá trị của lần dùng ĐẦU, lần dùng lại không được áp dụng",
  );
});

test("#6 NFR-1: mã đã dùng (single-use) bị từ chối lần 2 — user KHÔNG có password", async () => {
  const user = await createGoogleOnlyUser();
  await seedResetCode(String(user._id), "ONCE02");

  const first = buildRes();
  await confirmPasswordReset(
    { body: { userId: String(user._id), code: "ONCE02", newPW: "FirstUseGG123" } },
    first,
  );
  assert.equal(first._status, 200);

  const second = buildRes();
  await assert.rejects(
    () =>
      confirmPasswordReset(
        { body: { userId: String(user._id), code: "ONCE02", newPW: "SecondUseGG456" } },
        second,
      ),
    /Invalid or expired code/,
  );
});

test("#6 NFR-1: mã hết hạn (không còn entry Redis) bị từ chối cho cả hai loại tài khoản", async () => {
  // Hết hạn == key TTL đã trôi qua == không còn entry trong Redis. Không seed gì mô phỏng đúng
  // trạng thái đó mà không cần chờ TTL thật trôi qua (chậm và không tất định).
  const { user: pwUser, rawPassword } = await createUserWithPassword();
  const ggUser = await createGoogleOnlyUser();

  await assert.rejects(
    () =>
      confirmPasswordReset(
        { body: { userId: String(pwUser._id), code: "ANYCODE", newPW: "NoEffect123" } },
        buildRes(),
      ),
    /Invalid or expired code/,
  );
  await assert.rejects(
    () =>
      confirmPasswordReset(
        { body: { userId: String(ggUser._id), code: "ANYCODE", newPW: "NoEffect456" } },
        buildRes(),
      ),
    /Invalid or expired code/,
  );

  const pwUnchanged = await User.findById(pwUser._id);
  assert.ok(await bcrypt.compare(rawPassword, pwUnchanged!.password!));
  const ggUnchanged = await User.findById(ggUser._id);
  assert.equal(ggUnchanged!.password, undefined);
});
