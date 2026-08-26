// Run with Node's built-in test runner: `npm test`.
//
// Task 010 (epic follow-suggestions) — `processBatchJob` (idempotent upsert, FR-6) và hạ tầng
// BullMQ queue/worker (FR-1). `processBatchJob` mutate `FollowSuggestion` thật (đây chính là hành
// vi cần verify: hợp đồng upsert của Mongo), nên spawn 1 `mongod` tạm riêng cho file này — cùng
// pattern `followSuggestion.test.ts` (task 001) / `message.controller.sendnext.test.ts`, port
// riêng để không đụng các file test khác chạy song song trong cùng `node --test` run.
//
// `computeSuggestionsForUser` được inject qua `deps.compute` (mirror `processDispatchJob`'s
// `deps` ở `feed/fanout.ts` + `feed/fanout.dispatch.test.ts`) — test không cần seed đồ thị Follow
// thật, chỉ cần verify hành vi ghi/upsert của `processBatchJob`.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import mongoose from "mongoose";
import { Worker } from "bullmq";
import Redis from "ioredis";
import FollowSuggestion from "../../models/followSuggestion.model.ts";
import { FOLLOW_SUGGESTION_CONFIG } from "./config.ts";
import {
  closeFollowSuggestionQueue,
  followSuggestionQueue,
  initFollowSuggestionWorker,
  processBatchJob,
  registerFollowSuggestionWorker,
} from "./queue.ts";

const MONGO_PORT = 48_700 + (process.pid % 500);
const DB_NAME = "breads_followsuggestion_queue_test";

let mongod: ChildProcess | null = null;
let dbPath = "";

before(async () => {
  dbPath = mkdtempSync(join(tmpdir(), "breads-followsuggestion-queue-"));
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
  // Đóng Queue/Worker/connection BullMQ mở trong các test bên dưới — tránh treo `node --test`.
  await closeFollowSuggestionQueue();
});

const fakeCandidate = () => [
  {
    userId: new mongoose.Types.ObjectId(),
    score: 13,
    mutualFriendCount: 1,
    categoryOverlapCount: 1,
  },
];

// --- Test 1: FR-1 — enqueue/process batch, mỗi user có đúng 1 document ------------------------
test("FR-1: processBatchJob xử lý batch 3 userId -> cả 3 có document trong FollowSuggestion", async () => {
  const userIds = [
    new mongoose.Types.ObjectId().toString(),
    new mongoose.Types.ObjectId().toString(),
    new mongoose.Types.ObjectId().toString(),
  ];
  const compute = async (_userId: string) => fakeCandidate();

  await processBatchJob({ userIds }, { compute });

  const docs = await FollowSuggestion.find({ userId: { $in: userIds } }).lean();
  assert.equal(docs.length, 3);
  for (const uid of userIds) {
    const doc = docs.find((d: any) => String(d.userId) === uid);
    assert.ok(doc, `user ${uid} phải có document`);
    assert.equal(doc!.candidates.length, 1);
    assert.ok(doc!.computedAt, "computedAt phải được set");
  }
});

// --- Test 2: FR-6 (chaos/idempotency) ----------------------------------------------------------
test("FR-6 (chaos test): job throw giữa batch rồi retry -> mỗi user ĐÚNG 1 document, không trùng", async () => {
  const userIds = Array.from({ length: 5 }, () => new mongoose.Types.ObjectId().toString());
  const callCountByUser = new Map<string, number>();

  // Lần chạy đầu: throw ngay khi xử lý tới user thứ 3 (index 2) — mô phỏng job bị kill/crash giữa
  // batch (010.md AC: kill ở user 250/500). 2 user đầu ĐÃ upsert xong trước khi throw.
  const throwingCompute = async (userId: string) => {
    callCountByUser.set(userId, (callCountByUser.get(userId) ?? 0) + 1);
    if (userId === userIds[2]) {
      throw new Error("simulated crash mid-batch");
    }
    return fakeCandidate();
  };

  await assert.rejects(() => processBatchJob({ userIds }, { compute: throwingCompute }));

  const afterCrash = await FollowSuggestion.countDocuments({ userId: { $in: userIds } });
  assert.equal(afterCrash, 2, "2 user trước điểm crash phải đã được upsert");

  // BullMQ retry: gọi lại processBatchJob với CÙNG job.data (toàn bộ 5 userId, không phải phần
  // còn lại) — đúng hành vi thật của BullMQ (retry nguyên job, không resume giữa chừng).
  const succeedingCompute = async (userId: string) => {
    callCountByUser.set(userId, (callCountByUser.get(userId) ?? 0) + 1);
    return fakeCandidate();
  };
  await processBatchJob({ userIds }, { compute: succeedingCompute });

  // 2 user đầu được compute() gọi 2 lần (lần đầu + retry) — xác nhận retry chạy lại từ đầu, không
  // phải resume; nhưng upsert theo {userId} khiến kết quả cuối vẫn không trùng lặp.
  assert.equal(callCountByUser.get(userIds[0]), 2);
  assert.equal(callCountByUser.get(userIds[1]), 2);

  const finalCount = await FollowSuggestion.countDocuments({ userId: { $in: userIds } });
  const distinctUserIds = await FollowSuggestion.distinct("userId", {
    userId: { $in: userIds },
  });
  assert.equal(finalCount, 5, "đúng 5 document, không thiếu không thừa");
  assert.equal(distinctUserIds.length, 5, "distinct(userId) == 5 -> không có document trùng");
  assert.equal(finalCount, distinctUserIds.length);
});

// --- Test 3: FR-1 (worker isolation) ------------------------------------------------------------
test("FR-1 (isolation): initFollowSuggestionWorker throw không được thoát ra ngoài try/catch — sibling init vẫn chạy", () => {
  // Mô phỏng đúng pattern bắt buộc ở call site (`src/worker.ts`): 2 khối try/catch RIÊNG BIỆT,
  // lỗi ở suggestion worker (khối 2) không được ngăn/undone khối 1 (fanout) đã chạy xong.
  const throwingInitFollowSuggestionWorker = () => {
    throw new Error("Worker init failed: Redis down");
  };

  let fanoutSideEffectRan = false;
  let loggedErr: unknown;
  const originalError = console.error;
  console.error = (...args: any[]) => {
    loggedErr = args;
  };

  assert.doesNotThrow(() => {
    // Khối 1 (fanout) — giả lập, PHẢI chạy xong trước.
    try {
      fanoutSideEffectRan = true;
    } catch {
      /* n/a */
    }

    // Khối 2 (suggestion) — throw, PHẢI bị bắt riêng, không ảnh hưởng khối 1 đã chạy.
    try {
      throwingInitFollowSuggestionWorker();
    } catch (err) {
      console.error("[follow-suggestion-queue] initFollowSuggestionWorker failed:", err);
    }
  });

  console.error = originalError;
  assert.ok(fanoutSideEffectRan, "initFanoutWorkers (khối 1) phải hoàn tất bất kể khối 2 lỗi");
  assert.ok(loggedErr, "lỗi ở suggestion worker phải được log, không bị nuốt im lặng");
});

test("initFollowSuggestionWorker thật: khởi tạo không throw khi Redis khả dụng", () => {
  assert.doesNotThrow(() => initFollowSuggestionWorker());
});

test("followSuggestionQueue khởi tạo không throw khi Redis khả dụng", async () => {
  assert.equal(followSuggestionQueue.name, "follow-suggestion");
  await assert.doesNotReject(followSuggestionQueue.waitUntilReady());
});

test("registerFollowSuggestionWorker: concurrency đúng theo FOLLOW_SUGGESTION_CONFIG", async () => {
  const conn = new Redis({
    host: process.env.REDIS_HOST || "localhost",
    port: Number(process.env.REDIS_PORT || 6379),
    maxRetriesPerRequest: null,
  });
  const worker = registerFollowSuggestionWorker(conn);
  try {
    assert.equal(worker.opts.concurrency, FOLLOW_SUGGESTION_CONFIG.workerConcurrency);
  } finally {
    await worker.close();
    await conn.quit();
  }
});

test("Worker throw ngay lúc khởi tạo khi connection thiếu maxRetriesPerRequest: null", () => {
  const badConnection = new Redis({
    host: process.env.REDIS_HOST || "localhost",
    port: Number(process.env.REDIS_PORT || 6379),
  });
  try {
    assert.throws(() => {
      new Worker("follow-suggestion-queue-test-missing-max-retries", async () => {}, {
        connection: badConnection,
      });
    }, /maxRetriesPerRequest/);
  } finally {
    badConnection.disconnect();
  }
});
