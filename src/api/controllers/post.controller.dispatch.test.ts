import assert from "node:assert/strict";
import { after, test } from "node:test";
import { dispatchFanout } from "./post.controller.ts";
import { closeFanoutQueues } from "../services/feed/queue.ts";
import logger from "../../core/logger.ts";

const POST_ID = "652f1b2c3d4e5f6071829304";
const AUTHOR_ID = "652f1b2c3d4e5f6071829305";
const post = { _id: POST_ID, authorId: AUTHOR_ID };

const silence = async (fn: () => void | Promise<void>): Promise<void> => {
  const log = console.log;
  console.log = () => {};
  try {
    await fn();
  } finally {
    console.log = log;
  }
};

test("FR-2/scenario 1: mode mặc định (queue) + fanoutEnabled mặc định (true) -> dispatchQueue.add gọi đúng 1 lần với jobId=postId", async () => {
  const calls: any[][] = [];
  await silence(() =>
    dispatchFanout(post, null, {
      enqueue: async (name, data, opts) => {
        calls.push([name, data, opts]);
        return { id: opts.jobId };
      },
    }),
  );

  assert.equal(calls.length, 1);
  const [name, data, opts] = calls[0];
  assert.equal(name, "fanout-post");
  assert.deepEqual(data, { postId: POST_ID, authorId: AUTHOR_ID });
  assert.equal(opts.jobId, POST_ID);
  assert.equal(opts.attempts, 3);
  assert.deepEqual(opts.backoff, { type: "exponential", delay: 5000 });
  assert.deepEqual(opts.removeOnComplete, { count: 1000 });
  assert.deepEqual(opts.removeOnFail, { count: 5000 });
});

test("NFR-2: dispatchQueue.add reject -> dispatchFanout không throw, lỗi bị catch tại chỗ (createPost vẫn tiếp tục, vẫn trả 201)", async () => {
  let loggedErr: unknown;
  const originalError = logger.error;
  (logger as any).error = (obj: any) => {
    loggedErr = obj?.err;
  };

  try {
    await assert.doesNotReject(async () =>
      dispatchFanout(post, null, {
        enqueue: async () => {
          throw new Error("Redis down");
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    (logger as any).error = originalError;
  }

  assert.ok(loggedErr instanceof Error, "lỗi enqueue phải được catch và log, không bị nuốt im lặng hay throw ra ngoài");
});

after(async () => {
  await closeFanoutQueues();
});
