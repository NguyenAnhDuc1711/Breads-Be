// Run with Node's built-in test runner: `npm test`.
//
// Task 001 (epic follow-suggestions) — `computeSuggestionsForUser` chạy `$graphLookup` +
// `restrictSearchWithMatch` thật trên Mongo. Stub tầng model (pattern
// `post.controller.test.ts`) không chứng minh được gì ở đây — cái cần verify CHÍNH LÀ hành vi của
// aggregation engine (depth traversal, hub-node cap qua restrictSearchWithMatch), không phải code
// gọi nó. Theo pattern `message.controller.sendnext.test.ts`: spawn MỘT `mongod` tạm cho cả file,
// seed dữ liệu thật, gọi thẳng hàm — không mock.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import mongoose from "mongoose";
import Follow from "../models/follow.model.js";
import User from "../models/user.model.js";
import { FOLLOW_SUGGESTION_CONFIG } from "./followSuggestion/config.ts";
import { computeSuggestionsForUser } from "./followSuggestion.ts";

const MONGO_PORT = 48_200 + (process.pid % 500);
const DB_NAME = "breads_followsuggestion_test";

let mongod: ChildProcess | null = null;
let dbPath = "";

// FEED_CONFIG.celebrityThreshold mặc định = 50000 (feed/config.ts, env sạch trong test process) —
// dùng followersCount vượt hẳn ngưỡng đó để đánh dấu celebrity, không cần override env (module đã
// parse config lúc import, không cache-bust được giữa các test — SKL đã ghi ở feed/config.test.ts).
const CELEBRITY_FOLLOWERS = 100_000;

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

const follow = (followerId: unknown, followeeId: unknown) =>
  Follow.create({ followerId, followeeId });

before(async () => {
  dbPath = mkdtempSync(join(tmpdir(), "breads-followsuggestion-"));
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
      `(macOS: \`brew install mongodb-community\`) — KHÔNG được skip nó, vì \`$graphLookup\` ` +
      `không thể verify qua stub.`,
  );
});

after(async () => {
  await mongoose.disconnect().catch(() => {});
  mongod?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  if (dbPath) rmSync(dbPath, { recursive: true, force: true });
});

// --- Test 1: 2-hop cơ bản (Tests to Write bullet 1 + FR-1) -------------------------------------
test("computeSuggestionsForUser: A->B->C (2-hop) -> C xuất hiện với mutualFriendCount đúng", async () => {
  const a = await seedUser("t1-a");
  const b = await seedUser("t1-b");
  const c = await seedUser("t1-c");
  await follow(a._id, b._id);
  await follow(b._id, c._id);

  const result = await computeSuggestionsForUser(a._id);
  const candidate = result.find((r) => String(r.userId) === String(c._id));

  assert.ok(candidate, "C phải xuất hiện trong candidate");
  assert.equal(candidate!.mutualFriendCount, 1);
});

// --- Test 2: hub-node cap (Tests to Write bullet 2 + AC hub-node cap, AD-3) ---------------------
test("computeSuggestionsForUser: celebrity KHÔNG được dùng làm cầu nối, nhưng vẫn có thể tự là candidate", async () => {
  const a = await seedUser("t2-a");
  const bridge = await seedUser("t2-bridge"); // bạn thường của A, không phải celebrity
  const celeb = await seedUser("t2-celeb", { followersCount: CELEBRITY_FOLLOWERS });
  const decoy1 = await seedUser("t2-decoy1");
  const decoy2 = await seedUser("t2-decoy2");
  const decoy3 = await seedUser("t2-decoy3");

  // A follow thẳng celebrity (để celeb có mặt ở depth 0 — không phải candidate) và follow bridge
  // (bạn thường).
  await follow(a._id, celeb._id);
  await follow(a._id, bridge._id);
  // celeb tự follow 100 (rút gọn còn 3) người khác — đây là nhánh PHẢI bị chặn (X làm cầu nối).
  await follow(celeb._id, decoy1._id);
  await follow(celeb._id, decoy2._id);
  await follow(celeb._id, decoy3._id);
  // bridge (không phải celebrity) cũng follow celeb — đường hợp lệ để celeb vẫn có thể là candidate
  // qua tín hiệu khác (không đi qua vai trò cầu nối của chính celeb).
  await follow(bridge._id, celeb._id);

  const result = await computeSuggestionsForUser(a._id);
  const resultIds = result.map((r) => String(r.userId));

  // 100 người celeb follow KHÔNG được lọt vào chỉ vì đi qua celeb.
  assert.equal(resultIds.includes(String(decoy1._id)), false);
  assert.equal(resultIds.includes(String(decoy2._id)), false);
  assert.equal(resultIds.includes(String(decoy3._id)), false);

  // Nhưng celeb vẫn có thể là candidate hợp lệ (qua bridge, không phải qua vai trò cầu nối của
  // chính nó) — AD-3: celebrity KHÔNG bị loại khỏi kết quả cuối.
  const celebCandidate = result.find((r) => String(r.userId) === String(celeb._id));
  assert.ok(celebCandidate, "celebrity vẫn phải xuất hiện như candidate qua bridge hợp lệ");
  assert.equal(celebCandidate!.mutualFriendCount, 1);
});

// --- Test 3: công thức scoring (Tests to Write bullet 3 + FR-2) --------------------------------
test("computeSuggestionsForUser: score tính đúng theo FOLLOW_SUGGESTION_CONFIG (đọc từ config, không hard-code)", async () => {
  const a = await seedUser("t3-a");
  const bridgeP1 = await seedUser("t3-bridge-p1");
  const bridgeP2 = await seedUser("t3-bridge-p2");
  const bridgeP3 = await seedUser("t3-bridge-p3");
  const bridgeQ = await seedUser("t3-bridge-q");
  const p = await seedUser("t3-p"); // mutualFriendCount = 3
  const q = await seedUser("t3-q"); // mutualFriendCount = 1

  await follow(a._id, bridgeP1._id);
  await follow(a._id, bridgeP2._id);
  await follow(a._id, bridgeP3._id);
  await follow(a._id, bridgeQ._id);
  await follow(bridgeP1._id, p._id);
  await follow(bridgeP2._id, p._id);
  await follow(bridgeP3._id, p._id);
  await follow(bridgeQ._id, q._id);

  const result = await computeSuggestionsForUser(a._id);
  const pCandidate = result.find((r) => String(r.userId) === String(p._id));
  const qCandidate = result.find((r) => String(r.userId) === String(q._id));

  assert.ok(pCandidate);
  assert.ok(qCandidate);
  assert.equal(pCandidate!.mutualFriendCount, 3);
  assert.equal(pCandidate!.categoryOverlapCount, 0);
  assert.equal(qCandidate!.mutualFriendCount, 1);
  assert.equal(qCandidate!.categoryOverlapCount, 0);

  const expectedScoreP =
    FOLLOW_SUGGESTION_CONFIG.mutualFriendWeight * 3 +
    FOLLOW_SUGGESTION_CONFIG.categoryOverlapWeight * 0;
  const expectedScoreQ =
    FOLLOW_SUGGESTION_CONFIG.mutualFriendWeight * 1 +
    FOLLOW_SUGGESTION_CONFIG.categoryOverlapWeight * 0;

  assert.equal(pCandidate!.score, expectedScoreP);
  assert.equal(qCandidate!.score, expectedScoreQ);
  assert.ok(pCandidate!.score > qCandidate!.score, "score(P) phải > score(Q)");
});
