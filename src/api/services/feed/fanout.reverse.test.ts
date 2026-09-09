import assert from "node:assert/strict";
import { test } from "node:test";
import { Constants } from "../../../Breads-Shared/Constants/index.js";
import PostConstants from "../../../Breads-Shared/Constants/PostConstants.js";
import { FEED_CONFIG } from "./config.ts";
import { processBatchJob, processReverseDispatchJob } from "./fanout.ts";
import { BATCH_SIZE } from "./zset.ts";

const AUTHOR_ID = "652f1b2c3d4e5f6071829305";
const POST_ID = "652f1b2c3d4e5f6071829304";

const makeDeletedPost = (over: Record<string, any> = {}) => ({
  _id: POST_ID,
  authorId: AUTHOR_ID,
  type: PostConstants.ACTIONS.CREATE,
  status: Constants.POST_STATUS.DELETED,
  visibility: Constants.POST_VISIBILITY.PUBLIC,
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

const silence = async (fn: () => Promise<void>): Promise<void> => {
  const log = console.log;
  console.log = () => {};
  try {
    await fn();
  } finally {
    console.log = log;
  }
};

const run = (
  post: any,
  followerIds: string[],
  deps: Record<string, any> = {},
  data: Record<string, any> = {},
) =>
  processReverseDispatchJob(
    { postId: POST_ID, authorId: AUTHOR_ID, ...data },
    {
      loadPost: async () => post,
      loadAuthor: async () => ({ followersCount: followerIds.length }),
      getFollowerIds: async () => followerIds,
      ...deps,
    },
  );

test("bài đã xoá -> enqueue batch remove, jobId không đụng forward fanout", async () => {
  const rec = recorder();
  await silence(() =>
    run(makeDeletedPost(), ids(3), { enqueueBatches: rec.enqueueBatches }),
  );

  assert.equal(rec.calls.length, 1);
  const [job] = rec.calls[0];
  assert.equal(job.name, "reverse-batch");
  assert.equal(job.data.action, "remove");
  assert.deepEqual(job.data.followerIds, ids(3));
  assert.equal(job.opts.jobId, `${POST_ID}:rbatch:0`);
  assert.notEqual(job.opts.jobId, `${POST_ID}:batch:0`);
});

test("visibility ONLY_ME -> vẫn reverse fanout dù status còn ACTIVE", async () => {
  const rec = recorder();
  await silence(() =>
    run(
      makeDeletedPost({
        status: Constants.POST_STATUS.PUBLIC,
        visibility: Constants.POST_VISIBILITY.ONLY_ME,
      }),
      ids(2),
      { enqueueBatches: rec.enqueueBatches },
    ),
  );
  assert.equal(rec.calls.length, 1);
});

test("user undo trong lúc delay -> skip, không ZREM", async () => {
  const rec = recorder();
  await silence(() =>
    run(
      makeDeletedPost({
        status: Constants.POST_STATUS.PUBLIC,
        visibility: Constants.POST_VISIBILITY.PUBLIC,
      }),
      ids(3),
      { enqueueBatches: rec.enqueueBatches },
    ),
  );
  assert.equal(rec.calls.length, 0);
});

test("post đã bị hard-delete (null) -> vẫn dọn được nhờ authorId trong job data", async () => {
  const rec = recorder();
  await silence(() => run(null, ids(3), { enqueueBatches: rec.enqueueBatches }));
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0][0].data.followerIds.length, 3);
});

test("post null và job data không có authorId -> skip", async () => {
  const rec = recorder();
  await silence(() =>
    run(null, ids(3), { enqueueBatches: rec.enqueueBatches }, { authorId: undefined }),
  );
  assert.equal(rec.calls.length, 0);
});

test("REPLY chưa từng được fanout -> skip", async () => {
  const rec = recorder();
  await silence(() =>
    run(makeDeletedPost({ type: PostConstants.ACTIONS.REPLY }), ids(3), {
      enqueueBatches: rec.enqueueBatches,
    }),
  );
  assert.equal(rec.calls.length, 0);
});

test("celebrity -> skip, đối xứng với forward fanout (không bắn ZREM vô ích)", async () => {
  const rec = recorder();
  await silence(() =>
    run(makeDeletedPost(), ids(3), {
      loadAuthor: async () => ({
        followersCount: FEED_CONFIG.celebrityThreshold + 1,
      }),
      enqueueBatches: rec.enqueueBatches,
    }),
  );
  assert.equal(rec.calls.length, 0);
});

test("chia chunk theo BATCH_SIZE, mỗi chunk một jobId riêng", async () => {
  const rec = recorder();
  await silence(() =>
    run(makeDeletedPost(), ids(BATCH_SIZE * 2 + 1), {
      loadAuthor: async () => ({ followersCount: 3 }),
      enqueueBatches: rec.enqueueBatches,
    }),
  );
  const jobs = rec.calls[0];
  assert.equal(jobs.length, 3);
  assert.deepEqual(
    jobs.map((j: any) => j.opts.jobId),
    [`${POST_ID}:rbatch:0`, `${POST_ID}:rbatch:1`, `${POST_ID}:rbatch:2`],
  );
  assert.equal(jobs[2].data.followerIds.length, 1);
});

test("không follower active -> không enqueue batch nào", async () => {
  const rec = recorder();
  await silence(() =>
    run(makeDeletedPost(), [], { enqueueBatches: rec.enqueueBatches }),
  );
  assert.equal(rec.calls.length, 0);
});

test("processBatchJob: job cũ không có action vẫn chạy nhánh add (backward-compat)", async () => {
  await assert.rejects(
    () =>
      processBatchJob({
        postId: POST_ID,
        followerIds: ["u0"],
        scoreMs: Date.now(),
      } as any),
    /zAddPostForUsersOrThrow/,
    "job cũ phải đi vào nhánh ZADD, không được im lặng bỏ qua",
  );
});

test("processBatchJob: action=remove đi vào nhánh ZREM", async () => {
  await assert.rejects(
    () =>
      processBatchJob({
        postId: POST_ID,
        followerIds: ["u0"],
        action: "remove",
      } as any),
    /zRemovePostForUsers/,
  );
});
