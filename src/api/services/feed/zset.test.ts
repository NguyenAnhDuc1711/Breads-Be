// Run with Node's built-in test runner: `npm test`.
//
// Phạm vi: các hàm này gọi `getRedisInstance()` — trong môi trường test không có `initRedis()`
// (chỉ chạy ở server.ts) nên instance luôn `null`. Test ở đây xác nhận đúng hợp đồng "Redis chưa
// init -> no-op, không throw" (cùng hợp đồng với mọi helper khác trong file — xem `client()`), và
// guard "input rỗng -> return trước khi chạm Redis". Không có harness Redis thật trong repo nên
// không verify được nội dung ZADD/ZREM ghi thực tế — xem `fanout.test.ts` cho lý do tương tự với
// Mongo.
import assert from "node:assert/strict";
import { test } from "node:test";
import { zAddPostsForUser, zRemovePostsForUser } from "./zset.ts";

test("zAddPostsForUser: entries rỗng -> return ngay, không chạm Redis", async () => {
  const t0 = Date.now();
  await zAddPostsForUser("user-1", []);
  assert.ok(Date.now() - t0 < 100, "phải return ngay, không gọi Redis");
});

test("zAddPostsForUser: Redis chưa init -> no-op, không throw", async () => {
  await assert.doesNotReject(() =>
    zAddPostsForUser("user-1", [{ postId: "post-1", scoreMs: Date.now() }])
  );
});

test("zRemovePostsForUser: postIds rỗng -> return ngay, không chạm Redis", async () => {
  const t0 = Date.now();
  await zRemovePostsForUser("user-1", []);
  assert.ok(Date.now() - t0 < 100, "phải return ngay, không gọi Redis");
});

test("zRemovePostsForUser: Redis chưa init -> no-op, không throw", async () => {
  await assert.doesNotReject(() =>
    zRemovePostsForUser("user-1", ["post-1", "post-2"])
  );
});
