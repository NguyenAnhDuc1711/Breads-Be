// Run directly: `npx tsx --test src/api/migrations/verifyFollowSuggestionsBenchmark.test.ts`
// (NOT part of `npm test`'s glob — migrations/ isn't in it, same as `verifyEngagementScoreBackfillProd.ts`
// having no test file at all; task 021's Verification Checklist runs this file explicitly).
//
// Task 021 (epic follow-suggestions) — `runFollowSuggestionsBenchmark` measures SC-1 (precision@10)
// and SC-2 (P99 latency) through the REAL `getUserToFollows` controller (task 011) and the REAL
// `FollowSuggestion` cache, so — same reasoning as `followSuggestion.test.ts` (task 001) — a stub
// can't stand in for this: spawn one temp `mongod` for the file, seed real data, call the exported
// function directly (no HTTP layer, per epic.md's "gọi thẳng service layer để tránh nhiễu network").
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

  // --- Seed: ~50 users (Tests to Write: "seed nhỏ ~50-100 user") -------------------------------
  const USER_COUNT = 50;
  const users = [];
  for (let i = 0; i < USER_COUNT; i++) {
    users.push(await seedUser(`u${i}`, { followersCount: i }));
  }

  // A few Follow edges so exclude-followed logic has something real to filter (not the metric under
  // test here, just realistic input for the controller's normal control flow).
  await Follow.create({ followerId: users[0]._id, followeeId: users[1]._id });

  // Cache: give ~half the sampled users a real `FollowSuggestion` doc, some with a mutual-friend
  // candidate in the top-10 and some without, so precision@10 has a known, checkable answer.
  for (let i = 0; i < 25; i++) {
    const hasHit = i % 2 === 0; // 13 of 25 (i = 0,2,4,...,24) get mutualFriendCount > 0
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

  // 25 users have a cached doc (evaluated), 13 of those have a mutual-friend hit (i % 2 === 0 for
  // i in 0..24 -> 0,2,4,...,24 = 13 values).
  assert.equal(result.precisionAt10.evaluated, 25);
  assert.equal(result.precisionAt10.hits, 13);
  assert.equal(result.precisionAt10.ratio, 0.52);

  // Output file: written, valid JSON, matches the in-memory result.
  assert.ok(existsSync(result.outputFile), "output JSON file phải được ghi ra");
  const onDisk = JSON.parse(readFileSync(result.outputFile, "utf-8"));
  assert.deepEqual(onDisk, result);
});

test("runFollowSuggestionsBenchmark: user chưa có cache (backfill/cron chưa chạy) bị loại khỏi mẫu số precision, không tính là miss", async () => {
  const result = await runFollowSuggestionsBenchmark({ sampleSize: 50, outputDir });
  // 50 sampled, only 25 have a FollowSuggestion doc -> denominator is 25, not 50.
  assert.equal(result.precisionAt10.evaluated, 25);
  assert.notEqual(result.precisionAt10.evaluated, result.sampleSize);
});
