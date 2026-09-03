process.env.FOLLOW_SUGGESTION_ENABLED = "false";

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import mongoose from "mongoose";
import User from "../models/user.model.js";
import FollowSuggestion from "../models/followSuggestion.model.js";

const MONGO_PORT = 48_900 + (process.pid % 500);
const DB_NAME = "breads_followsuggestion_benchmark_killswitch_test";

let mongod: ChildProcess | null = null;
let dbPath = "";
let outputDir = "";

let seq = 0;
const seedUser = (name: string) => {
  seq += 1;
  return User.create({
    name,
    username: `${name}-${seq}`,
    email: `${name}-${seq}@example.com`,
    password: "password123",
  });
};

before(async () => {
  dbPath = mkdtempSync(join(tmpdir(), "breads-followsuggestion-benchmark-ks-"));
  outputDir = mkdtempSync(join(tmpdir(), "breads-followsuggestion-benchmark-ks-out-"));
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
  assert.ok(connected, `Không kết nối được MongoDB tạm ở ${uri}. Cần \`mongod\` trên PATH.`);

  const users = [];
  for (let i = 0; i < 20; i++) {
    users.push(await seedUser(`ks${i}`));
  }
  await FollowSuggestion.create({
    userId: users[0]._id,
    candidates: [{ userId: users[1]._id, score: 10, mutualFriendCount: 3, categoryOverlapCount: 0 }],
  });
});

after(async () => {
  await mongoose.disconnect().catch(() => {});
  mongod?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  if (dbPath) rmSync(dbPath, { recursive: true, force: true });
  if (outputDir) rmSync(outputDir, { recursive: true, force: true });
});

test("runFollowSuggestionsBenchmark: FOLLOW_SUGGESTION_ENABLED=false -> chạy được, dùng fallback path, không throw", async () => {
  const { runFollowSuggestionsBenchmark } = await import("./verifyFollowSuggestionsBenchmark.ts");
  const { FOLLOW_SUGGESTION_CONFIG } = await import("../services/followSuggestion/config.ts");
  const { default: FollowSuggestionModel } = await import("../models/followSuggestion.model.ts");

  assert.equal(FOLLOW_SUGGESTION_CONFIG.enabled, false, "env override phải có hiệu lực");

  let cacheReadCalls = 0;
  const originalFindOne = (FollowSuggestionModel as any).findOne;
  (FollowSuggestionModel as any).findOne = (...args: any[]) => {
    cacheReadCalls++;
    return originalFindOne.apply(FollowSuggestionModel, args);
  };

  let result;
  try {
    result = await runFollowSuggestionsBenchmark({ sampleSize: 20, outputDir });
  } finally {
    (FollowSuggestionModel as any).findOne = originalFindOne;
  }

  assert.equal(result.followSuggestionEnabled, false);
  assert.equal(result.sampleSize, 20);
  for (const key of ["p50", "p95", "p99", "min", "max", "avg"] as const) {
    assert.equal(typeof result.latencyMs[key], "number");
    assert.ok(result.latencyMs[key] >= 0);
  }
  assert.equal(result.precisionAt10.evaluated, 1);
  assert.equal(result.precisionAt10.hits, 1);

  assert.equal(cacheReadCalls, 20, "chỉ có precision-read gọi FollowSuggestion.findOne, controller không gọi (kill-switch off)");
});
