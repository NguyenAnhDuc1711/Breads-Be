process.env.FEED_FANOUT_MODE = "direct";

import assert from "node:assert/strict";
import { after, test } from "node:test";

let closeFanoutQueues: () => Promise<void>;

const silence = async (fn: () => void | Promise<void>): Promise<void> => {
  const log = console.log;
  console.log = () => {};
  try {
    await fn();
  } finally {
    console.log = log;
  }
};

const POST_ID = "652f1b2c3d4e5f6071829304";
const AUTHOR_ID = "652f1b2c3d4e5f6071829305";
const post = { _id: POST_ID, authorId: AUTHOR_ID };
const io = { fake: "io" };

test("FR-8/scenario 1: FEED_FANOUT_MODE=direct -> fanoutPostToFollowers gọi trực tiếp như cũ, dispatchQueue.add KHÔNG được gọi", async () => {
  const { dispatchFanout } = await import("./post.controller.ts");
  const { FEED_CONFIG } = await import("../services/feed/config.ts");
  closeFanoutQueues = (await import("../services/feed/queue.ts")).closeFanoutQueues;
  assert.equal(FEED_CONFIG.fanoutMode, "direct", "env override phải có hiệu lực");

  const directCalls: any[] = [];
  let enqueueCalls = 0;
  await silence(() =>
    dispatchFanout(post, io, {
      fanoutDirect: async (args) => {
        directCalls.push(args);
      },
      enqueue: async () => {
        enqueueCalls++;
        return {};
      },
    }),
  );

  assert.equal(directCalls.length, 1);
  assert.equal(directCalls[0].post, post);
  assert.equal(directCalls[0].io, io);
  assert.equal(enqueueCalls, 0);
});

after(async () => {
  await closeFanoutQueues();
});
