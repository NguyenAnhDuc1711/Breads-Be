// Run with Node's built-in test runner: `npm test`.
//
// Phạm vi: fix CRITICAL của plan-review (AD-3, task 011) — `zAddPostForUsersOrThrow` phải throw
// khi pipeline Redis lỗi (để BullMQ retry hoạt động thật cho batch job, FR-6), trong khi
// `zAddPostForUsers` gốc PHẢI giữ nguyên hành vi "không bao giờ throw" (R-5 — không được vô tình
// đổi hành vi caller cũ). Tách khỏi `zset.test.ts` có chủ đích: file đó dựa vào giả định "Redis
// chưa init -> `getRedisInstance()` trả null" (xem header của nó); file này cần một kết nối Redis
// THẬT để mô phỏng lỗi pipeline (mock `r.pipeline`) và để so sánh kết quả ghi ZSET thật giữa 2
// hàm — gộp chung sẽ phá vỡ giả định null-instance mà các test hiện có của `zset.test.ts` dựa
// vào. Đòi hỏi Redis chạy thật ở localhost:6379, cùng điều kiện `queue.test.ts` đã đòi hỏi.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import initRedis, { getRedisInstance } from "../../../dbs/redis.ts";
import { feedKey, zAddPostForUsers, zAddPostForUsersOrThrow } from "./zset.ts";

before(async () => {
  initRedis();
  await new Promise<void>((resolve, reject) => {
    const r = getRedisInstance()!;
    if (r.status === "ready") return resolve();
    r.once("ready", () => resolve());
    r.once("error", reject);
  });
});

after(async () => {
  // Đóng connection mà `initRedis()` ở trên mở ra để `node --test` thoát được (không có
  // `closeRedis()` export sẵn trong `dbs/redis.ts`, `quit()` trực tiếp qua `getRedisInstance()`).
  await getRedisInstance()?.quit();
});

/**
 * Pipeline giả: mọi command được ghi lại (đúng thứ tự `zadd -> zremrangebyrank -> expire` như
 * pipeline thật) nhưng lệnh ĐẦU TIÊN trả lỗi — đúng shape `[Error, null]` mà ioredis
 * `pipeline.exec()` trả cho một command lỗi bên trong một pipeline đã gửi thành công (xem comment
 * gốc ở `zset.ts::logPipelineErrors` giải thích shape này). Không chạm mạng thật.
 */
const makeFailingPipeline = () => {
  const ops: string[] = [];
  const self: any = {
    zadd: (..._args: any[]) => {
      ops.push("zadd");
      return self;
    },
    zremrangebyrank: (..._args: any[]) => {
      ops.push("zremrangebyrank");
      return self;
    },
    expire: (..._args: any[]) => {
      ops.push("expire");
      return self;
    },
    exec: async () =>
      ops.map((_op, i) => (i === 0 ? [new Error("mock pipeline failure"), null] : [null, "OK"])),
  };
  return self;
};

test("AD-3 fix CRITICAL: zAddPostForUsersOrThrow throw khi pipeline lỗi (mock)", async () => {
  const r: any = getRedisInstance();
  const original = r.pipeline.bind(r);
  r.pipeline = () => makeFailingPipeline();
  try {
    await assert.rejects(
      () => zAddPostForUsersOrThrow(["u-fail-1", "u-fail-2"], "post-fail", Date.now()),
      /command\(s\) failed/
    );
  } finally {
    r.pipeline = original;
  }
});

test("R-5: zAddPostForUsers gốc VẪN không throw với cùng input lỗi (hành vi caller cũ không đổi)", async () => {
  const r: any = getRedisInstance();
  const original = r.pipeline.bind(r);
  r.pipeline = () => makeFailingPipeline();
  try {
    await assert.doesNotReject(() =>
      zAddPostForUsers(["u-fail-1", "u-fail-2"], "post-fail", Date.now())
    );
  } finally {
    r.pipeline = original;
  }
});

test("2 hàm cho cùng kết quả ZSET với input hợp lệ (đồng bộ logic pipeline giữa zAddPostForUsers và zAddPostForUsersOrThrow)", async () => {
  const r = getRedisInstance()!;
  const scoreMs = Date.now();
  const usersA = ["zset011test-plain-1", "zset011test-plain-2"];
  const usersB = ["zset011test-throw-1", "zset011test-throw-2"];
  const postId = "zset011test-post";
  try {
    await zAddPostForUsers(usersA, postId, scoreMs);
    await zAddPostForUsersOrThrow(usersB, postId, scoreMs);

    for (let i = 0; i < usersA.length; i++) {
      const scoreA = await r.zscore(feedKey(usersA[i]), postId);
      const scoreB = await r.zscore(feedKey(usersB[i]), postId);
      assert.equal(scoreA, String(scoreMs), "zAddPostForUsers phải ghi đúng score");
      assert.equal(scoreB, String(scoreMs), "zAddPostForUsersOrThrow phải ghi đúng score y hệt");

      const ttlA = await r.ttl(feedKey(usersA[i]));
      const ttlB = await r.ttl(feedKey(usersB[i]));
      assert.ok(ttlA > 0, "zAddPostForUsers phải tự EXPIRE key");
      assert.ok(ttlB > 0, "zAddPostForUsersOrThrow phải tự EXPIRE key y hệt");
    }
  } finally {
    await r.del(...usersA.map(feedKey), ...usersB.map(feedKey));
  }
});

test("zAddPostForUsersOrThrow: input hợp lệ, Redis khoẻ -> không throw", async () => {
  const r = getRedisInstance()!;
  try {
    await assert.doesNotReject(() =>
      zAddPostForUsersOrThrow(["zset011test-ok-1"], "zset011test-post-ok", Date.now())
    );
  } finally {
    await r.del(feedKey("zset011test-ok-1"));
  }
});
