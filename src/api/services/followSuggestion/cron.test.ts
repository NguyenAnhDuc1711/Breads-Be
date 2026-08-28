// Run with Node's built-in test runner: `npm test`.
//
// Task 012 (epic follow-suggestions) — lock TTL-based (AD-7) + enqueue batch cursor. Cần Redis
// THẬT (giống `zset.batch.test.ts`, `queue.test.ts`) cho lock (Redis `SET NX EX` là hành vi
// atomic của Redis thật, không đáng để mock) và Mongo THẬT (spawn `mongod` tạm riêng, giống
// `queue.test.ts`) cho phần cursor user theo `_id`. `enqueue` được inject qua `deps.enqueue`
// (mirror `deps.compute` ở `queue.test.ts`) — không cần chạm BullMQ/Redis-cho-queue thật để đếm
// batch, dù import `cron.ts` -> `queue.ts` vẫn tạo `Queue` thật ở module scope (xem SKL-006 trong
// skillbook: file này KHÔNG tự thoát khi chạy standalone `npx tsx --test`, chỉ chạy sạch qua
// `npm test` — glob nhiều file. Đây là đặc điểm pre-existing của repo, không phải bug ở đây).
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import mongoose from "mongoose";
import initRedis, { getRedisInstance } from "../../../dbs/redis.ts";
import User from "../../models/user.model.ts";
import { closeFollowSuggestionQueue } from "./queue.ts";
import {
  LOCK_KEY,
  acquireLock,
  initFollowSuggestionCron,
  runFollowSuggestionRefresh,
} from "./cron.ts";

const MONGO_PORT = 49_200 + (process.pid % 500);
const DB_NAME = "breads_followsuggestion_cron_test";

let mongod: ChildProcess | null = null;
let dbPath = "";

before(async () => {
  dbPath = mkdtempSync(join(tmpdir(), "breads-followsuggestion-cron-"));
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

  initRedis();
  await new Promise<void>((resolve, reject) => {
    const r = getRedisInstance()!;
    if (r.status === "ready") return resolve();
    r.once("ready", () => resolve());
    r.once("error", reject);
  });
});

after(async () => {
  await mongoose.disconnect().catch(() => {});
  mongod?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  if (dbPath) rmSync(dbPath, { recursive: true, force: true });
  await getRedisInstance()?.del(LOCK_KEY).catch(() => {});
  await getRedisInstance()?.quit();
  // `cron.ts` import `queue.ts` -> `followSuggestionQueue`/Worker thật được tạo ở module scope dù
  // test này không gọi enqueue thật — đóng lại để không góp thêm handle treo (SKL-006).
  await closeFollowSuggestionQueue();
});

// Dọn lock giữa các test — `LOCK_KEY` là hằng số cố định (dùng chung với backfill task 020), nên
// nhiều test acquire liên tiếp sẽ đụng nhau nếu không xoá key trước mỗi case.
beforeEach(async () => {
  await getRedisInstance()!.del(LOCK_KEY);
});

const makeLockValue = () => `test:${Date.now()}:${Math.random().toString(36).slice(2)}`;

// --- Test 1: acquire lock loại trừ lẫn nhau trong cùng TTL window -----------------------------
test("acquireLock: 2 lần acquire liên tiếp trong cùng TTL window -> lần 2 thất bại (lock đã bị giữ)", async () => {
  const first = await acquireLock(makeLockValue(), 30);
  assert.equal(first, true, "lần acquire đầu tiên (không có ai giữ lock) phải thành công");

  const second = await acquireLock(makeLockValue(), 30);
  assert.equal(second, false, "lần acquire thứ 2 trong cùng TTL window phải thất bại");
});

// --- Test 2: TTL tự hết hạn -> acquire lại thành công (AC "tự giải phóng sau crash") ----------
test("acquireLock: TTL ngắn hết hạn -> acquire lần sau thành công (mô phỏng crash không release)", async () => {
  const first = await acquireLock(makeLockValue(), 1);
  assert.equal(first, true);

  // Chưa hết TTL -> vẫn bị giữ (khẳng định lại hành vi, tránh false positive nếu TTL=1 quá ngắn
  // để đo được sự khác biệt).
  const tooEarly = await acquireLock(makeLockValue(), 30);
  assert.equal(tooEarly, false, "chưa hết TTL 1s thì acquire vẫn phải thất bại");

  await new Promise((r) => setTimeout(r, 1300));

  const afterExpiry = await acquireLock(makeLockValue(), 30);
  assert.equal(
    afterExpiry,
    true,
    "sau khi hết TTL, lock phải tự giải phóng (không cần ai gọi release) -> acquire lần sau thành công",
  );
});

// --- Test 3: enqueue theo batch cursor -----------------------------------------------------------
test("runFollowSuggestionRefresh: enqueue đúng số batch job = ceil(tổng user / batchSize)", async () => {
  await User.deleteMany({});
  const TOTAL_USERS = 7;
  const BATCH_SIZE = 3; // inject nhỏ để không cần seed 300+ user thật (ENQUEUE_BATCH_SIZE mặc định)

  // `lastActiveAt` gần đây bắt buộc phải set — cron giờ chỉ quét user trong active-window
  // (activeWindowDays), test này đo logic chia batch nên seed toàn bộ user active để không bị
  // filter đó loại mất (xem test riêng bên dưới cho chính hành vi filter).
  const docs = Array.from({ length: TOTAL_USERS }, (_, i) => ({
    name: `User ${i}`,
    username: `cron_test_user_${i}_${Date.now()}`,
    email: `cron_test_user_${i}_${Date.now()}@example.com`,
    password: "password123",
    lastActiveAt: new Date(),
  }));
  await User.insertMany(docs);

  const enqueuedBatches: string[][] = [];
  const result = await runFollowSuggestionRefresh({
    batchSize: BATCH_SIZE,
    enqueue: async (data) => {
      enqueuedBatches.push(data.userIds);
    },
  });

  assert.equal(result.acquired, true);
  const expectedJobCount = Math.ceil(TOTAL_USERS / BATCH_SIZE);
  assert.equal(result.jobCount, expectedJobCount);
  assert.equal(enqueuedBatches.length, expectedJobCount);

  const allEnqueuedUserIds = enqueuedBatches.flat();
  assert.equal(allEnqueuedUserIds.length, TOTAL_USERS);
  assert.equal(new Set(allEnqueuedUserIds).size, TOTAL_USERS, "không user nào bị enqueue trùng");

  const allUserIdsInDb = (await User.find({}).select("_id").lean()).map((u: any) =>
    String(u._id),
  );
  assert.deepEqual(
    [...allEnqueuedUserIds].sort(),
    [...allUserIdsInDb].sort(),
    "mọi user trong DB đều được enqueue đúng 1 lần",
  );
});

// --- Test: active-window filter (rút gọn tệp user, tránh quét/tính lại suggestion cho user không
// mở app) ------------------------------------------------------------------------------------------
test("runFollowSuggestionRefresh: chỉ enqueue user active trong activeWindowDays gần nhất", async () => {
  await User.deleteMany({});
  const DAY_MS = 86_400_000;
  const now = Date.now();
  const suffix = Date.now();

  const activeUser = await User.create({
    name: "Active",
    username: `cron_test_active_${suffix}`,
    email: `cron_test_active_${suffix}@example.com`,
    password: "password123",
    lastActiveAt: new Date(now - 1 * DAY_MS), // 1 ngày trước — trong window 7 ngày
  });
  await User.create({
    name: "Stale",
    username: `cron_test_stale_${suffix}`,
    email: `cron_test_stale_${suffix}@example.com`,
    password: "password123",
    lastActiveAt: new Date(now - 10 * DAY_MS), // 10 ngày trước — ngoài window
  });
  await User.create({
    name: "NeverActive",
    username: `cron_test_never_${suffix}`,
    email: `cron_test_never_${suffix}@example.com`,
    password: "password123",
    // không set lastActiveAt — user mới, chưa từng qua protectRoute/socket connect.
  });

  const enqueuedBatches: string[][] = [];
  const result = await runFollowSuggestionRefresh({
    enqueue: async (data) => {
      enqueuedBatches.push(data.userIds);
    },
  });

  assert.deepEqual(
    enqueuedBatches.flat(),
    [String(activeUser._id)],
    "chỉ user active trong 7 ngày gần nhất được enqueue, user stale/chưa từng active bị loại",
  );
  assert.equal(result.jobCount, 1);
});

test("runFollowSuggestionRefresh: 0 user -> acquired=true nhưng jobCount=0, không gọi enqueue", async () => {
  await User.deleteMany({});
  let enqueueCalls = 0;
  const result = await runFollowSuggestionRefresh({
    enqueue: async () => {
      enqueueCalls += 1;
    },
  });
  assert.equal(result.acquired, true);
  assert.equal(result.jobCount, 0);
  assert.equal(enqueueCalls, 0);
});

// --- Test 4: NFR-2 scenario "ngăn overlap" -------------------------------------------------------
test("runFollowSuggestionRefresh: lock đang bị giữ (vd backfill task 020) -> KHÔNG enqueue, acquired=false", async () => {
  // Giả lập backfill task 020 đang giữ lock (cùng LOCK_KEY, TTL dài).
  const backfillHoldsLock = await acquireLock("simulated-backfill-task-020", 30);
  assert.equal(backfillHoldsLock, true);

  let enqueueCalls = 0;
  const result = await runFollowSuggestionRefresh({
    enqueue: async () => {
      enqueueCalls += 1;
    },
  });

  assert.equal(result.acquired, false);
  assert.equal(result.jobCount, 0);
  assert.equal(enqueueCalls, 0, "cron KHÔNG được enqueue job nào khi lock đang bị giữ");
});

// --- Test 5: bootstrap không throw + dọn dẹp task ------------------------------------------------
test("initFollowSuggestionCron: đăng ký cron theo refreshCronSchedule không throw", () => {
  const task = initFollowSuggestionCron();
  assert.ok(task, "phải trả về ScheduledTask");
  task.stop();
});
