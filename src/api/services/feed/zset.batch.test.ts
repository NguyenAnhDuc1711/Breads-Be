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
  await getRedisInstance()?.quit();
});

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
