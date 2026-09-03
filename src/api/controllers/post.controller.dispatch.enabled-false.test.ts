process.env.FEED_FANOUT_ENABLED = "false";

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

test("FR-2/scenario 2: FEED_FANOUT_ENABLED=false -> dispatchQueue.add và fanoutPostToFollowers đều KHÔNG được gọi", async () => {
  const { dispatchFanout } = await import("./post.controller.ts");
  const { FEED_CONFIG } = await import("../services/feed/config.ts");
  closeFanoutQueues = (await import("../services/feed/queue.ts")).closeFanoutQueues;
  assert.equal(FEED_CONFIG.fanoutEnabled, false, "env override phải có hiệu lực");
  assert.equal(FEED_CONFIG.fanoutMode, "queue", "test này giả định mode mặc định, không phải direct");

  let enqueueCalls = 0;
  let directCalls = 0;
  await silence(() =>
    dispatchFanout(post, null, {
      enqueue: async () => {
        enqueueCalls++;
        return {};
      },
      fanoutDirect: async () => {
        directCalls++;
      },
    }),
  );

  assert.equal(enqueueCalls, 0);
  assert.equal(directCalls, 0);
});

after(async () => {
  await closeFanoutQueues();
});
