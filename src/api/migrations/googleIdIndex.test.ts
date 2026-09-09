import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import mongoose from "mongoose";
import User from "../models/user.model.ts";

const MONGO_PORT = 49_700 + (process.pid % 500);
const DB_NAME = "breads_googleidindex_test";

let mongod: ChildProcess | null = null;
let dbPath = "";

let seq = 0;
const nextUser = (overrides: Record<string, unknown> = {}) => {
  seq += 1;
  return {
    name: `gid-user-${seq}`,
    username: `gid-user-${seq}`,
    email: `gid-user-${seq}@example.com`,
    ...overrides,
  };
};

before(async () => {
  dbPath = mkdtempSync(join(tmpdir(), "breads-googleidindex-"));
  mongod = spawn(
    "mongod",
    [
      "--dbpath",
      dbPath,
      "--port",
      String(MONGO_PORT),
      "--bind_ip",
      "127.0.0.1",
      "--setParameter",
      "enableTestCommands=1",
    ],
    { stdio: "ignore" },
  );
  mongod.on("error", () => {
    /* lỗi spawn được báo qua timeout kết nối bên dưới, kèm hướng dẫn rõ ràng */
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

  // Đảm bảo index (kể cả googleId_1 sparse) được đồng bộ trước khi test chạy,
  // giống hành vi autoIndex khi app khởi động lần đầu trên DB rỗng.
  await User.syncIndexes();
});

after(async () => {
  await mongoose.disconnect().catch(() => {});
  mongod?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  if (dbPath) rmSync(dbPath, { recursive: true, force: true });
});

test("tạo user không có password -> không ném lỗi validate (FR-10)", async () => {
  await User.deleteMany({});
  const user = await User.create(nextUser());
  assert.ok(user._id);
  assert.equal(user.password, undefined);
});

test("tạo user với password 5 ký tự -> ném lỗi minLength (FR-10)", async () => {
  await User.deleteMany({});
  await assert.rejects(
    () => User.create(nextUser({ password: "12345" })),
    (err: unknown) => {
      assert.ok(err instanceof mongoose.Error.ValidationError);
      assert.ok(err.errors.password);
      return true;
    },
  );
});

test("hai user đều không có googleId -> cả hai đều tạo thành công (sparse index, ca quan trọng nhất)", async () => {
  await User.deleteMany({});
  const u1 = await User.create(nextUser());
  const u2 = await User.create(nextUser());
  assert.ok(u1._id);
  assert.ok(u2._id);
  assert.equal(u1.googleId, undefined);
  assert.equal(u2.googleId, undefined);
  assert.equal(await User.countDocuments({}), 2);
});

test("hai user cùng googleId -> user thứ hai ném E11000 (unique index)", async () => {
  await User.deleteMany({});
  await User.create(nextUser({ googleId: "dup-google-sub" }));
  await assert.rejects(
    () => User.create(nextUser({ googleId: "dup-google-sub" })),
    (err: unknown) => {
      assert.equal((err as { code?: number }).code, 11000);
      return true;
    },
  );
});

test("user cũ (có password, không googleId) vẫn đọc/ghi bình thường (NFR-1, không hồi quy)", async () => {
  await User.deleteMany({});
  const legacy = await User.create(nextUser({ password: "password123" }));
  assert.equal(legacy.googleId, undefined);

  const found = await User.findById(legacy._id);
  assert.ok(found);
  assert.equal(found!.password, "password123");

  found!.bio = "updated bio";
  await found!.save();
  const reloaded = await User.findById(legacy._id);
  assert.equal(reloaded!.bio, "updated bio");
});
