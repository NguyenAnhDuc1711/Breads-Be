// Run with Node's built-in test runner: `npm test`.
//
// Task 020 (epic follow-suggestions) — `runBackfill` (core loop của `backfillFollowSuggestions.ts`,
// KHÔNG bao gồm lock/CLI — xem comment trong file nguồn) chạy trên `FollowSuggestion`/`User` thật
// (upsert của `processBatchJob`, task 010, là hành vi cần verify — stub không chứng minh được gì),
// nên spawn 1 `mongod` tạm riêng cho file này, cùng pattern `followSuggestion.test.ts` /
// `followSuggestion/queue.test.ts`. `computeSuggestionsForUser` được inject qua `deps.compute` khi
// test cần kiểm soát chính xác concurrency/thời điểm lỗi (mirror `queue.test.ts`) — test "full run"
// dùng compute THẬT (không seed Follow graph, user không follow ai -> candidates rỗng, đủ để verify
// mọi user có doc).
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import mongoose from "mongoose";
import FollowSuggestion from "../models/followSuggestion.model.ts";
import User from "../models/user.model.ts";
import { runBackfill } from "./backfillFollowSuggestions.ts";

const MONGO_PORT = 49_700 + (process.pid % 500);
const DB_NAME = "breads_backfillfollowsuggestions_test";

let mongod: ChildProcess | null = null;
let dbPath = "";

let seq = 0;
const seedUsers = async (count: number) => {
  const ids: mongoose.Types.ObjectId[] = [];
  for (let i = 0; i < count; i += 1) {
    seq += 1;
    const u = await User.create({
      name: `bf-user-${seq}`,
      username: `bf-user-${seq}`,
      email: `bf-user-${seq}@example.com`,
      password: "password123",
    });
    ids.push(u._id);
  }
  return ids;
};

before(async () => {
  dbPath = mkdtempSync(join(tmpdir(), "breads-backfillfollowsuggestions-"));
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
});

after(async () => {
  await mongoose.disconnect().catch(() => {});
  mongod?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  if (dbPath) rmSync(dbPath, { recursive: true, force: true });
});

// --- Test 1: full run (020.md AC "chạy đầy đủ") -------------------------------------------------
test("runBackfill: N user chưa có FollowSuggestion -> sau khi chạy đầy đủ, cả N user có doc", async () => {
  await User.deleteMany({});
  await FollowSuggestion.deleteMany({});
  const ids = await seedUsers(23); // không chia hết cho concurrency mặc định -> phủ trang cuối lẻ

  const { processedCount } = await runBackfill({ concurrency: 5, resume: false });

  assert.equal(processedCount, 23);
  assert.equal(await FollowSuggestion.countDocuments(), 23);
  for (const id of ids) {
    const doc = await FollowSuggestion.findOne({ userId: id });
    assert.ok(doc, `user ${id} phải có FollowSuggestion doc`);
    assert.ok(doc!.computedAt instanceof Date);
  }
});

// --- Test 2: concurrency limit (020.md AC "concurrency limit") ----------------------------------
test("runBackfill: số lời gọi compute in-flight cùng lúc không bao giờ vượt --concurrency", async () => {
  await User.deleteMany({});
  await FollowSuggestion.deleteMany({});
  await seedUsers(17);

  let inFlight = 0;
  let maxInFlight = 0;
  const CONCURRENCY = 4;
  const compute = async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 25));
    inFlight -= 1;
    return [];
  };

  const { processedCount } = await runBackfill(
    { concurrency: CONCURRENCY, resume: false },
    { compute },
  );

  assert.equal(processedCount, 17);
  assert.ok(maxInFlight <= CONCURRENCY, `maxInFlight=${maxInFlight} phải <= ${CONCURRENCY}`);
  assert.equal(maxInFlight, CONCURRENCY, "concurrency phải thực sự được tận dụng, không chỉ 1");
});

// --- Test 3: resume sau crash (020.md AC "resume sau crash", plan-review FAIL-3) -----------------
test("runBackfill: --resume sau crash giữa chừng -> chỉ xử lý phần còn lại, không trùng/bỏ sót", async () => {
  await User.deleteMany({});
  await FollowSuggestion.deleteMany({});
  const CONCURRENCY = 5;
  const ids = await seedUsers(CONCURRENCY * 2); // đúng 2 trang -> crash ngay ranh giới trang 1/2

  let callCount = 0;
  const crashingCompute = async () => {
    callCount += 1;
    if (callCount > CONCURRENCY) {
      throw new Error("simulated crash mid-run");
    }
    return [];
  };

  await assert.rejects(() =>
    runBackfill({ concurrency: CONCURRENCY, resume: false }, { compute: crashingCompute }),
  );

  // Chỉ trang 1 (N/2 user đầu) được xử lý xong và có checkpoint lưu lại.
  assert.equal(await FollowSuggestion.countDocuments(), CONCURRENCY);
  const firstHalfDocs = await FollowSuggestion.find({ userId: { $in: ids } }).lean();
  const computedAtBeforeResume = new Map(
    firstHalfDocs.map((d) => [String(d.userId), d.computedAt.getTime()]),
  );

  // Chạy lại với --resume (compute thật, không throw nữa) -> chỉ N/2 user còn lại được xử lý.
  const { processedCount } = await runBackfill({ concurrency: CONCURRENCY, resume: true });

  assert.equal(processedCount, CONCURRENCY, "resume chỉ được xử lý N/2 user còn lại, không hơn");
  assert.equal(await FollowSuggestion.countDocuments(), ids.length);
  const distinctUserIds = await FollowSuggestion.distinct("userId");
  assert.equal(distinctUserIds.length, ids.length, "không được trùng lặp/bỏ sót user nào");

  // N/2 user đã xong ở lần chạy trước KHÔNG bị xử lý lại (computedAt không đổi).
  const afterDocs = await FollowSuggestion.find({
    userId: { $in: Array.from(computedAtBeforeResume.keys()) },
  }).lean();
  for (const doc of afterDocs) {
    assert.equal(
      doc.computedAt.getTime(),
      computedAtBeforeResume.get(String(doc.userId)),
      `user ${doc.userId} (đã xong ở lần chạy trước) không được xử lý lại`,
    );
  }
});
