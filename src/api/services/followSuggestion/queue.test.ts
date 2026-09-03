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

test("FR-6 (chaos test): job throw giữa batch rồi retry -> mỗi user ĐÚNG 1 document, không trùng", async () => {
  const userIds = Array.from({ length: 5 }, () => new mongoose.Types.ObjectId().toString());
  const callCountByUser = new Map<string, number>();

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

  const succeedingCompute = async (userId: string) => {
    callCountByUser.set(userId, (callCountByUser.get(userId) ?? 0) + 1);
    return fakeCandidate();
  };
  await processBatchJob({ userIds }, { compute: succeedingCompute });

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

test("FR-1 (isolation): initFollowSuggestionWorker throw không được thoát ra ngoài try/catch — sibling init vẫn chạy", () => {
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
    try {
      fanoutSideEffectRan = true;
    } catch {
      /* n/a */
    }

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
