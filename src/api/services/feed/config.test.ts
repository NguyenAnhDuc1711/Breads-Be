// Run with Node's built-in test runner: `npm test`.
//
// Phạm vi: CHỈ helper thuần `ratio` (5 nhánh của FR-1). KHÔNG test `FEED_CONFIG` qua
// `process.env` — `FEED_CONFIG` parse lúc import module, và ESM cache module theo tiến trình
// nên không cache-bust được để thử nhiều giá trị env trong cùng một lần chạy test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FEED_CONFIG, ratio } from "./config.ts";

test("ratio: chưa set (undefined/empty) -> default", () => {
  assert.equal(ratio(undefined, 0.15, "K"), 0.15);
  assert.equal(ratio("", 0.15, "K"), 0.15);
});

test("ratio: không parse được -> default", () => {
  assert.equal(ratio("abc", 0.15, "K"), 0.15);
  assert.equal(ratio("NaN", 0.15, "K"), 0.15);
  assert.equal(ratio("Infinity", 0.15, "K"), 0.15);
});

test("ratio: âm -> default, KHÔNG clamp về 0", () => {
  const result = ratio("-0.5", 0.15, "K");
  assert.equal(result, 0.15);
  assert.notEqual(result, 0);
});

test("ratio: > 1 -> clamp về 1", () => {
  assert.equal(ratio("15", 0.15, "K"), 1);
});

test("ratio: 0 là giá trị hợp lệ, KHÔNG rơi về default", () => {
  assert.equal(ratio("0", 0.15, "K"), 0);
});

test("ratio: biên trong khoảng [0,1] giữ nguyên giá trị", () => {
  assert.equal(ratio("0.15", 0.15, "K"), 0.15);
  assert.equal(ratio("1", 0.15, "K"), 1);
  assert.equal(ratio("0.5", 0.15, "K"), 0.5);
});

test("FEED_CONFIG: bất biến và default của 3 key mới (env sạch)", () => {
  assert.equal(Object.isFrozen(FEED_CONFIG), true);
  assert.equal(FEED_CONFIG.discoveryEnabled, true);
  assert.equal(FEED_CONFIG.discoveryRatio, 0.15);
  assert.equal(FEED_CONFIG.discoveryMaxSkip, 1000);
});
