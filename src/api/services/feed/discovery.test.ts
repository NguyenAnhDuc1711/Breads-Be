// Run with Node's built-in test runner: `npm test`.
//
// Phạm vi: CHỈ tầng thuần của discovery.ts (planDiscovery, accountDiscovery). Nhánh I/O
// (getDiscoveryCandidates, task 011/T3) chưa tồn tại ở file nguồn khi test này được viết — sẽ
// verify bằng tay khi 011 thêm vào, vì repo chưa có harness Mongo (tiền lệ fanout.test.ts:1-6).
//
// Không import discoveryBatchSize để test giá trị 45 — nó đọc FEED_CONFIG (parse lúc import,
// không cache-bust được qua ESM); các case dưới truyền `batch` tường minh vào planDiscovery.
import assert from "node:assert/strict";
import { test } from "node:test";
import { planDiscovery, accountDiscovery } from "./discovery.ts";

// Hằng số dùng chung cho nhóm planDiscovery.
const batch = 45;
const maxSkip = 1000;
const limit = 20;
const basePoolSize = 300;
// effectivePoolSize = 300 + 45 = 345

// ---- Nhóm A — bảng chọn chế độ FR-3 ----

test("FR-3.1: enabled=false, trang nông -> off", () => {
  const plan = planDiscovery({
    enabled: false,
    source: "zset",
    basePoolSize,
    skip: 0,
    limit,
    batch,
    maxSkip,
  });
  assert.deepEqual(plan, { mode: "off", offset: 0, n: 0 });
});

test("FR-3.2: enabled=false, trang sâu -> vẫn off (kill-switch thắng extend)", () => {
  const plan = planDiscovery({
    enabled: false,
    source: "zset",
    basePoolSize,
    skip: 400,
    limit,
    batch,
    maxSkip,
  });
  assert.deepEqual(plan, { mode: "off", offset: 0, n: 0 });
});

test("FR-3.3: source=zset, skip=0 -> blend, offset=0, n=batch", () => {
  const plan = planDiscovery({
    enabled: true,
    source: "zset",
    basePoolSize,
    skip: 0,
    limit,
    batch,
    maxSkip,
  });
  assert.deepEqual(plan, { mode: "blend", offset: 0, n: 45 });
});

test("FR-3.4: source=mongo-fallback, trang nông -> off (không trùng mục đích)", () => {
  const plan = planDiscovery({
    enabled: true,
    source: "mongo-fallback",
    basePoolSize,
    skip: 0,
    limit,
    batch,
    maxSkip,
  });
  assert.deepEqual(plan, { mode: "off", offset: 0, n: 0 });
});

test("FR-3.5 [W-2]: source=mongo-fallback, trang sâu -> extend, KHÔNG phải off", () => {
  const plan = planDiscovery({
    enabled: true,
    source: "mongo-fallback",
    basePoolSize,
    skip: 400,
    limit,
    batch,
    maxSkip,
  });
  assert.deepEqual(plan, { mode: "extend", offset: 100, n: 20 });
});

test("FR-3.6 [ca bẫy US-1]: basePoolSize nhỏ (viewer follow ít) -> vẫn blend, không extend", () => {
  // basePoolSize=12 (viewer follow 3 người), effectivePoolSize = 12 + 45 = 57 >= skip+limit=20
  // -> phải là blend. Nếu ngưỡng dùng basePoolSize trần trụi (12 < 20) sẽ sai sang extend và
  // xoá sạch 12 bài cá nhân hoá của viewer — đây là AC quan trọng nhất của task.
  const plan = planDiscovery({
    enabled: true,
    source: "zset",
    basePoolSize: 12,
    skip: 0,
    limit,
    batch,
    maxSkip,
  });
  assert.notEqual(plan.mode, "extend");
  assert.equal(plan.mode, "blend");
});

// ---- Nhóm B — công thức cursor FR-4 ----

test("FR-4.7: skip=400 -> offset=100", () => {
  const plan = planDiscovery({
    enabled: true,
    source: "zset",
    basePoolSize,
    skip: 400,
    limit,
    batch,
    maxSkip,
  });
  assert.equal(plan.mode, "extend");
  assert.equal(plan.offset, 100);
});

test("FR-4.8: skip=420 -> offset=120; chênh đúng limit=20 so với skip=400 (SC-4)", () => {
  const plan400 = planDiscovery({
    enabled: true,
    source: "zset",
    basePoolSize,
    skip: 400,
    limit,
    batch,
    maxSkip,
  });
  const plan420 = planDiscovery({
    enabled: true,
    source: "zset",
    basePoolSize,
    skip: 420,
    limit,
    batch,
    maxSkip,
  });
  assert.equal(plan420.offset, 120);
  assert.equal(plan420.offset - plan400.offset, 20);
});

test("FR-4.9: skip=340 (ranh giới) -> extend, offset=45 (max(0,-5)=0)", () => {
  const plan = planDiscovery({
    enabled: true,
    source: "zset",
    basePoolSize,
    skip: 340,
    limit,
    batch,
    maxSkip,
  });
  assert.equal(plan.mode, "extend");
  assert.equal(plan.offset, 45);
});

test("FR-4.10: skip=340 và skip=360 -> cửa sổ [45,65) và [60,80) giao đúng 5 phần tử (R-6)", () => {
  const plan340 = planDiscovery({
    enabled: true,
    source: "zset",
    basePoolSize,
    skip: 340,
    limit,
    batch,
    maxSkip,
  });
  const plan360 = planDiscovery({
    enabled: true,
    source: "zset",
    basePoolSize,
    skip: 360,
    limit,
    batch,
    maxSkip,
  });
  assert.equal(plan360.offset, 60);
  // [45,65) và [60,80) -> giao là [60,65), độ dài 5. Đây là hệ quả ĐÃ BIẾT của max(0,...),
  // cận trên limit-1, chỉ xảy ra ở chỗ chuyển chế độ (R-6) — không phải bug.
  const windowA = { start: plan340.offset, end: plan340.offset + limit };
  const windowB = { start: plan360.offset, end: plan360.offset + limit };
  const overlap = Math.max(
    0,
    Math.min(windowA.end, windowB.end) - Math.max(windowA.start, windowB.start)
  );
  assert.equal(overlap, 5);
});

test("FR-4.11: skip=100000 -> offset kẹp trần ở maxSkip=1000, không phải 99700", () => {
  const plan = planDiscovery({
    enabled: true,
    source: "zset",
    basePoolSize,
    skip: 100000,
    limit,
    batch,
    maxSkip,
  });
  assert.equal(plan.offset, 1000);
  assert.notEqual(plan.offset, 99700);
});

test("FR-4.12: dấu > chứ không phải >= tại ngưỡng effectivePoolSize", () => {
  // skip=344, limit=20 -> 364 > 345 -> extend
  const planOver = planDiscovery({
    enabled: true,
    source: "zset",
    basePoolSize,
    skip: 344,
    limit,
    batch,
    maxSkip,
  });
  assert.equal(planOver.mode, "extend");
  assert.equal(planOver.offset, 45);

  // skip=325, limit=20 -> 345 === 345, KHÔNG > -> blend
  const planEq = planDiscovery({
    enabled: true,
    source: "zset",
    basePoolSize,
    skip: 325,
    limit,
    batch,
    maxSkip,
  });
  assert.equal(planEq.mode, "blend");
});

// ---- Nhóm C — batch=0 (W-1 làm ca này viết được, vì batch nhận qua tham số) ----

test("FR-1+FR-3.13: batch=0, trang nông -> blend nhưng n=0 (call-site tự bỏ qua query)", () => {
  const plan = planDiscovery({
    enabled: true,
    source: "zset",
    basePoolSize: 300,
    skip: 0,
    limit,
    batch: 0,
    maxSkip,
  });
  assert.equal(plan.mode, "blend");
  assert.equal(plan.n, 0);
});

test("FR-1+FR-3.14: batch=0, trang sâu -> extend vẫn chạy bình thường", () => {
  // effectivePoolSize = 300 + 0 = 300; skip=400, limit=20 -> 420 > 300 -> extend
  const plan = planDiscovery({
    enabled: true,
    source: "zset",
    basePoolSize: 300,
    skip: 400,
    limit,
    batch: 0,
    maxSkip,
  });
  assert.equal(plan.mode, "extend");
  assert.equal(plan.n, limit);
  assert.equal(plan.offset, Math.min(0 + (400 - 300), maxSkip));
  assert.equal(plan.offset, 100);
});

// ---- Nhóm D — accountDiscovery ----

test("FR-5.15: không bài discovery nào lọt trang -> shown=0, bestRank=null, avgRank=null", () => {
  const page = Array.from({ length: 20 }, (_, i) => `post-${i}`);
  const result = accountDiscovery(page, ["discovery-a", "discovery-b"]);
  assert.equal(result.shown, 0);
  assert.notEqual(result.bestRank, 0);
  assert.equal(result.bestRank, null);
  assert.equal(result.avgRank, null);
  assert.equal(Number.isNaN(result.avgRank as any), false);
});

test("FR-5.16: 1 bài discovery ở đầu trang (index 0) -> shown=1, bestRank=1, avgRank=1", () => {
  const page = ["disc-1", "p2", "p3"];
  const result = accountDiscovery(page, ["disc-1"]);
  assert.deepEqual(result, { shown: 1, bestRank: 1, avgRank: 1 });
});

test("FR-5.17: 1 bài discovery ở giữa (index 9) -> bestRank=10", () => {
  const page = Array.from({ length: 20 }, (_, i) => (i === 9 ? "disc-1" : `p${i}`));
  const result = accountDiscovery(page, ["disc-1"]);
  assert.equal(result.bestRank, 10);
});

test("NTH-2 FR-5.18: 1 bài discovery ở cuối trang (index 19) -> bestRank=20", () => {
  const page = Array.from({ length: 20 }, (_, i) => (i === 19 ? "disc-1" : `p${i}`));
  const result = accountDiscovery(page, ["disc-1"]);
  assert.equal(result.bestRank, 20);
});

test("FR-5.19: 3 bài discovery ở index 4,11,19 -> shown=3, bestRank=5, avgRank=(5+12+20)/3", () => {
  const page = Array.from({ length: 20 }, (_, i) => {
    if (i === 4) return "disc-a";
    if (i === 11) return "disc-b";
    if (i === 19) return "disc-c";
    return `p${i}`;
  });
  const result = accountDiscovery(page, ["disc-a", "disc-b", "disc-c"]);
  assert.equal(result.shown, 3);
  assert.equal(result.bestRank, 5);
  assert.equal(result.avgRank, (5 + 12 + 20) / 3);
});

test("FR-5.20: page=[] -> shown=0, bestRank=null, avgRank=null, không throw", () => {
  const result = accountDiscovery([], ["disc-a"]);
  assert.deepEqual(result, { shown: 0, bestRank: null, avgRank: null });
});

test("FR-5.21 [CRIT-1]: page là ObjectId-like objects, discoveryIds là string[] -> shown đếm đúng, không phải 0", () => {
  // Mô phỏng ObjectId: object có toString() trả hex, KHÔNG phải string primitive.
  // Set<string>.has(objectId) dùng SameValueZero (so identity) nên luôn false nếu không String()
  // cả hai phía — đây là ca test tồn tại để CRIT-1 không tái phạm (xem TR-5).
  const makeObjectIdLike = (hex: string) => ({
    toString: () => hex,
    // đảm bảo template-literal/String() coercion cũng đi qua toString(), giống ObjectId thật.
  });
  const page: unknown[] = [
    makeObjectIdLike("64a000000000000000000001"),
    makeObjectIdLike("64a000000000000000000002"),
    makeObjectIdLike("64a000000000000000000003"),
  ];
  const discoveryIds = [
    "64a000000000000000000002",
    "64a000000000000000000099",
  ];
  const result = accountDiscovery(page, discoveryIds);
  assert.notEqual(result.shown, 0);
  assert.equal(result.shown, 1);
  assert.equal(result.bestRank, 2);
});
