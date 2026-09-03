import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import mongoose from "mongoose";
import User from "../models/user.model.js";
import Follow from "../models/follow.model.js";
import FollowSuggestion from "../models/followSuggestion.model.js";
import { runFollowSuggestionsBenchmark } from "./verifyFollowSuggestionsBenchmark.ts";

const MONGO_PORT = 48_700 + (process.pid % 500);
const DB_NAME = "breads_followsuggestion_benchmark_test";

let mongod: ChildProcess | null = null;
let dbPath = "";
let outputDir = "";

let seq = 0;
const seedUser = (name: string, overrides: Record<string, unknown> = {}) => {
  seq += 1;
  return User.create({
    name,
    username: `${name}-${seq}`,
    email: `${name}-${seq}@example.com`,
    password: "password123",
    ...overrides,
  });
};

before(async () => {
  dbPath = mkdtempSync(join(tmpdir(), "breads-followsuggestion-benchmark-"));
  outputDir = mkdtempSync(join(tmpdir(), "breads-followsuggestion-benchmark-out-"));
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
    /* connection-retry loop below reports failure with a clear message */
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
      `(macOS: \`brew install mongodb-community\`).`,
  );

  const USER_COUNT = 50;
  const users = [];
  for (let i = 0; i < USER_COUNT; i++) {
    users.push(await seedUser(`u${i}`, { followersCount: i }));
  }

  await Follow.create({ followerId: users[0]._id, followeeId: users[1]._id });

  for (let i = 0; i < 25; i++) {
    const hasHit = i % 2 === 0;
    const candidates = [
      {
        userId: users[(i + 1) % USER_COUNT]._id,
        score: 10,
        mutualFriendCount: hasHit ? 2 : 0,
        categoryOverlapCount: 0,
      },
      {
        userId: users[(i + 2) % USER_COUNT]._id,
        score: 5,
        mutualFriendCount: 0,
        categoryOverlapCount: 1,
      },
    ];
    await FollowSuggestion.create({ userId: users[i]._id, candidates });
  }
});

after(async () => {
  await mongoose.disconnect().catch(() => {});
  mongod?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  if (dbPath) rmSync(dbPath, { recursive: true, force: true });
  if (outputDir) rmSync(outputDir, { recursive: true, force: true });
});

test("runFollowSuggestionsBenchmark: chạy end-to-end trên seed nhỏ, không throw, output đủ field P50/P95/P99 + precision@10", async () => {
  const result = await runFollowSuggestionsBenchmark({ sampleSize: 50, outputDir });

  assert.equal(result.sampleSize, 50);
  assert.equal(typeof result.followSuggestionEnabled, "boolean");

  for (const key of ["p50", "p95", "p99", "min", "max", "avg"] as const) {
    assert.equal(typeof result.latencyMs[key], "number", `latencyMs.${key} phải là number`);
    assert.ok(result.latencyMs[key] >= 0, `latencyMs.${key} phải >= 0`);
  }
  assert.ok(result.latencyMs.p50 <= result.latencyMs.p95, "P50 <= P95");
  assert.ok(result.latencyMs.p95 <= result.latencyMs.p99, "P95 <= P99");

  assert.equal(result.precisionAt10.evaluated, 25);
  assert.equal(result.precisionAt10.hits, 13);
  assert.equal(result.precisionAt10.ratio, 0.52);

  assert.ok(existsSync(result.outputFile), "output JSON file phải được ghi ra");
  const onDisk = JSON.parse(readFileSync(result.outputFile, "utf-8"));
  assert.deepEqual(onDisk, result);
});

test("runFollowSuggestionsBenchmark: user chưa có cache (backfill/cron chưa chạy) bị loại khỏi mẫu số precision, không tính là miss", async () => {
  const result = await runFollowSuggestionsBenchmark({ sampleSize: 50, outputDir });
  assert.equal(result.precisionAt10.evaluated, 25);
  assert.notEqual(result.precisionAt10.evaluated, result.sampleSize);
});
