process.env.FEED_SOCKET_ENABLED = "true";

import assert from "node:assert/strict";
import { test } from "node:test";
import { Constants } from "../../../Breads-Shared/Constants/index.js";
import PostConstants from "../../../Breads-Shared/Constants/PostConstants.js";

let mods: {
  FEED_CONFIG: any;
  BATCH_SIZE: number;
  processDispatchJob: any;
  socketSentKey: (postId: string) => string;
};
const load = async () => {
  if (!mods) {
    const [config, zset, fanout] = await Promise.all([
      import("./config.ts"),
      import("./zset.ts"),
      import("./fanout.ts"),
    ]);
    mods = {
      FEED_CONFIG: config.FEED_CONFIG,
      BATCH_SIZE: zset.BATCH_SIZE,
      processDispatchJob: fanout.processDispatchJob,
      socketSentKey: fanout.socketSentKey,
    };
  }
  return mods;
};

const AUTHOR_ID = "652f1b2c3d4e5f6071829305";
const POST_ID = "652f1b2c3d4e5f6071829304";

const makePost = (over: Record<string, any> = {}) => ({
  _id: POST_ID,
  authorId: AUTHOR_ID,
  type: PostConstants.ACTIONS.CREATE,
  visibility: Constants.POST_VISIBILITY.PUBLIC,
  createdAt: new Date("2026-08-09T00:00:00.000Z"),
  ...over,
});

const recorder = () => {
  const calls: any[][] = [];
  return {
    calls,
    enqueueBatches: async (jobs: any[]) => {
      calls.push(jobs);
      return jobs;
    },
  };
};

const ids = (n: number, prefix = "u") =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`);

const fakeRedis = () => {
  const store = new Map<string, { value: string; ttl: number }>();
  return {
    store,
    exists: async (key: string) => (store.has(key) ? 1 : 0),
    set: async (key: string, value: string, mode: string, ttl: number) => {
      assert.equal(mode, "EX", "cờ socket phải có TTL, không được set vĩnh viễn");
      store.set(key, { value, ttl });
      return "OK";
    },
  };
};

const silence = async (fn: () => Promise<void>): Promise<void> => {
  const log = console.log;
  console.log = () => {};
  try {
    await fn();
  } finally {
    console.log = log;
  }
};

const run = async (
  post: any,
  followerIds: string[],
  extra: Record<string, any> = {},
  io?: any,
) => {
  const { processDispatchJob } = await load();
  return processDispatchJob({ postId: POST_ID, authorId: AUTHOR_ID }, io, {
    loadPost: async () => post,
    loadAuthor: async () => ({ followersCount: followerIds.length }),
    getFollowerIds: async () => followerIds,
    ...extra,
  });
};

test("FR-3/scenario 2: 4500 follower -> đúng 3 batch job 2000/2000/500, jobId riêng biệt", async () => {
  const { BATCH_SIZE } = await load();
  const rec = recorder();
  await silence(() =>
    run(makePost(), ids(4500), { enqueueBatches: rec.enqueueBatches }),
  );

  assert.equal(rec.calls.length, 1, "addBulk gọi đúng 1 lần cho cả lượt dispatch");
  const jobs = rec.calls[0];
  assert.equal(jobs.length, 3);
  assert.deepEqual(
    jobs.map((j: any) => j.data.followerIds.length),
    [BATCH_SIZE, BATCH_SIZE, 500],
  );
  assert.deepEqual(
    jobs.map((j: any) => j.opts.jobId),
    [`${POST_ID}:batch:0`, `${POST_ID}:batch:1`, `${POST_ID}:batch:2`],
  );
  assert.equal(new Set(jobs.map((j: any) => j.opts.jobId)).size, 3);
  assert.deepEqual(jobs.flatMap((j: any) => j.data.followerIds), ids(4500));
});

test("FR-3/scenario 1: 3 follower -> đúng 1 batch job chứa cả 3", async () => {
  const rec = recorder();
  await silence(() =>
    run(makePost(), ids(3), { enqueueBatches: rec.enqueueBatches }),
  );
  const jobs = rec.calls[0];
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].name, "fanout-batch");
  assert.deepEqual(jobs[0].data.followerIds, ids(3));
});

test("Interface contract cho task 011: payload {postId, followerIds, scoreMs} + job options FR-6/FR-7", async () => {
  const rec = recorder();
  const post = makePost();
  await silence(() =>
    run(post, ids(2), { enqueueBatches: rec.enqueueBatches }),
  );
  const job = rec.calls[0][0];
  assert.deepEqual(Object.keys(job.data).sort(), ["followerIds", "postId", "scoreMs"]);
  assert.equal(job.data.postId, POST_ID);
  assert.equal(job.data.scoreMs, new Date(post.createdAt).getTime());
  assert.equal(job.opts.attempts, 3);
  assert.deepEqual(job.opts.backoff, { type: "exponential", delay: 5000 });
  assert.deepEqual(job.opts.removeOnComplete, { count: 5000 });
  assert.deepEqual(job.opts.removeOnFail, { count: 5000 });
});

test("FR-3/scenario 3: author trên ngưỡng celebrity -> 0 batch job", async () => {
  const { FEED_CONFIG, processDispatchJob } = await load();
  const rec = recorder();
  await silence(() =>
    processDispatchJob({ postId: POST_ID, authorId: AUTHOR_ID }, undefined, {
      loadPost: async () => makePost(),
      loadAuthor: async () => ({
        followersCount: FEED_CONFIG.celebrityThreshold + 1,
      }),
      getFollowerIds: async () => {
        throw new Error("cổng celebrity phải return TRƯỚC truy vấn follower");
      },
      enqueueBatches: rec.enqueueBatches,
    }),
  );
  assert.equal(rec.calls.length, 0);
});

test("FR-3/scenario 4: visibility ONLY_ME -> 0 batch job, return trước cả truy vấn author", async () => {
  const { processDispatchJob } = await load();
  const rec = recorder();
  await silence(() =>
    processDispatchJob({ postId: POST_ID, authorId: AUTHOR_ID }, undefined, {
      loadPost: async () => makePost({ visibility: Constants.POST_VISIBILITY.ONLY_ME }),
      loadAuthor: async () => {
        throw new Error("cổng ONLY_ME phải return TRƯỚC User.findOne");
      },
      getFollowerIds: async () => {
        throw new Error("cổng ONLY_ME phải return TRƯỚC truy vấn follower");
      },
      enqueueBatches: rec.enqueueBatches,
    }),
  );
  assert.equal(rec.calls.length, 0);
});

test("reply (type ngoài CREATE/EDIT/REPOST) -> 0 batch job; post đã bị xoá -> 0 batch job, không throw", async () => {
  const { processDispatchJob } = await load();
  const rec = recorder();
  await silence(() =>
    run(makePost({ type: PostConstants.ACTIONS.REPLY }), ids(5), {
      enqueueBatches: rec.enqueueBatches,
    }),
  );
  assert.equal(rec.calls.length, 0);

  await assert.doesNotReject(() =>
    silence(() =>
      processDispatchJob({ postId: POST_ID }, undefined, {
        loadPost: async () => null,
        enqueueBatches: rec.enqueueBatches,
      }),
    ),
  );
  assert.equal(rec.calls.length, 0);
});

test("FR-3/scenario 5: dispatch job retry -> addBulk lặp cùng jobId, không sinh job trùng", async () => {
  const store = new Map<string, any>();
  const enqueueBatches = async (jobs: any[]) => {
    for (const j of jobs) if (!store.has(j.opts.jobId)) store.set(j.opts.jobId, j);
    return jobs;
  };
  const followers = ids(4500);
  const boom = {
    exists: async () => {
      throw new Error("Redis down giữa chừng");
    },
  };

  await assert.rejects(() =>
    silence(() => run(makePost(), followers, { enqueueBatches, redis: boom })),
  );
  assert.equal(store.size, 3, "lần chạy đầu tạo 3 batch job");

  await silence(() => run(makePost(), followers, { enqueueBatches }));
  assert.equal(store.size, 3, "retry KHÔNG được nhân đôi batch job");
});

const fakeIo = () => {
  const emits: { socketId: string; event: string; payload: any }[] = [];
  return {
    emits,
    io: {
      fetchSockets: async () => [
        { id: "sock-0", data: { userId: "u0", id: "sock-0" } },
        { id: "sock-1", data: { userId: "u1", id: "sock-1" } },
      ],
      to: (socketId: string) => ({
        emit: (event: string, payload: any) => emits.push({ socketId, event, payload }),
      }),
    },
  };
};

test("FR-5/scenario 1+2: emit đúng 1 lần dù dispatch job chạy lại; cờ socket-sent set TTL 3600s", async () => {
  const { FEED_CONFIG, socketSentKey } = await load();
  assert.equal(FEED_CONFIG.socketEnabled, true, "env FEED_SOCKET_ENABLED phải có hiệu lực");
  const redis = fakeRedis();
  const rec = recorder();
  const { emits, io } = fakeIo();

  await silence(() =>
    run(makePost(), ids(3), { enqueueBatches: rec.enqueueBatches, redis }, io),
  );
  assert.equal(emits.length, 2, "2 follower online -> 2 emit ở lần chạy đầu");
  assert.deepEqual(emits[0].payload, { postId: POST_ID, authorId: AUTHOR_ID });

  const flag = redis.store.get(socketSentKey(POST_ID));
  assert.ok(flag, "cờ feed:fanout:socket-sent:{postId} phải được set sau khi emit");
  assert.equal(flag.ttl, 3600);

  await silence(() =>
    run(makePost(), ids(3), { enqueueBatches: rec.enqueueBatches, redis }, io),
  );
  assert.equal(emits.length, 2, "retry không được emit lần 2 cho cùng postId");
});

test("AD-4: getAllSockets quét registry đúng 1 lần cho cả lượt dispatch, không phải 1 lần/batch", async () => {
  const redis = fakeRedis();
  const rec = recorder();
  let scans = 0;
  const io = {
    fetchSockets: async () => {
      scans++;
      return [{ id: "sock-0", data: { userId: "u0", id: "sock-0" } }];
    },
    to: () => ({ emit: () => {} }),
  };
  await silence(() =>
    run(makePost(), ids(4500), { enqueueBatches: rec.enqueueBatches, redis }, io),
  );
  assert.equal(rec.calls[0].length, 3);
  assert.equal(scans, 1);
});

test("socket: postId khác -> cờ riêng, vẫn emit (cờ không được khoá nhầm post khác)", async () => {
  const { processDispatchJob, socketSentKey } = await load();
  const redis = fakeRedis();
  const rec = recorder();
  const { emits, io } = fakeIo();
  const other = "652f1b2c3d4e5f6071829399";

  await silence(() =>
    run(makePost(), ids(1), { enqueueBatches: rec.enqueueBatches, redis }, io),
  );
  await silence(() =>
    processDispatchJob({ postId: other, authorId: AUTHOR_ID }, io, {
      loadPost: async () => makePost({ _id: other }),
      loadAuthor: async () => ({ followersCount: 1 }),
      getFollowerIds: async () => ids(1),
      enqueueBatches: rec.enqueueBatches,
      redis,
    }),
  );
  assert.equal(emits.length, 2);
  assert.ok(redis.store.has(socketSentKey(POST_ID)));
  assert.ok(redis.store.has(socketSentKey(other)));
});
