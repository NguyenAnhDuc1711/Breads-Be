// Run with Node's built-in test runner: `npm test`.
//
// Phạm vi: CHỈ helper thuần `boolFlag`. KHÔNG test `POST_CONFIG` qua `process.env` —
// `POST_CONFIG` parse lúc import module, và ESM cache module theo tiến trình nên không
// cache-bust được để thử nhiều giá trị env trong cùng một lần chạy test (cùng lý do đã
// nêu trong `feed/config.test.ts`).
import assert from "node:assert/strict";
import { test } from "node:test";
import { boolFlag, POST_CONFIG } from "./config.ts";

test("boolFlag: env absent -> OFF (an toàn theo mặc định)", () => {
  assert.equal(boolFlag(undefined), false);
});

test('boolFlag: env = "true" -> ON', () => {
  assert.equal(boolFlag("true"), true);
});

test('boolFlag: env = "false" -> OFF', () => {
  assert.equal(boolFlag("false"), false);
});

test("boolFlag: giá trị rác bất kỳ -> OFF (fail-safe)", () => {
  assert.equal(boolFlag("1"), false);
  assert.equal(boolFlag("TRUE"), false);
  assert.equal(boolFlag(""), false);
  assert.equal(boolFlag("yes"), false);
});

test("POST_CONFIG: bất biến và default OFF (env sạch)", () => {
  assert.equal(Object.isFrozen(POST_CONFIG), true);
  assert.equal(POST_CONFIG.responseFieldFilterEnabled, false);
});
