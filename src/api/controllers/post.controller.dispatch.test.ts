// Run with Node's built-in test runner: `npm test`.
//
// Phạm vi: Task 012 (`dispatchFanout`, `post.controller.ts`) — nhánh mặc định (`FEED_FANOUT_MODE`
// KHÔNG set -> "queue", `FEED_FANOUT_ENABLED` KHÔNG set -> `true`, đúng default thật của
// `config.ts`, không cần override env). File này KHÔNG set `process.env` trước khi import, nên
// dùng chung process/import cache với mọi test khác đọc `FEED_CONFIG` ở default state.
//
// Không gọi `createPost` trực tiếp (repo chưa có harness Mongo — xem `fanout.test.ts`,
// `fanout.dispatch.test.ts`). Thay vào đó test thẳng `dispatchFanout`, hàm được tách riêng đúng
// mục đích test độc lập 4 nhánh FR-2/FR-8/NFR-2 mà không cần Mongo/Redis thật, cùng pattern
// dependency-injection `processDispatchJob` đã dùng ở task 010/011.
//
// `post.controller.ts` import `dispatchQueue` từ `queue.ts`, mở một connection ioredis thật ngay
// lúc import — phải `closeFanoutQueues()` ở `after()` để `node --test` thoát được, cùng lý do
// `queue.test.ts` đã làm (xem comment ở đó).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { dispatchFanout } from "./post.controller.ts";
import { closeFanoutQueues } from "../services/feed/queue.ts";

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
  const originalLog = console.log;
  console.log = (...args: any[]) => {
    if (args[0] === "[feed-fanout] enqueue error") loggedErr = args[1];
  };

  try {
    await assert.doesNotReject(async () =>
      dispatchFanout(post, null, {
        enqueue: async () => {
          throw new Error("Redis down");
        },
      }),
    );
    // `dispatchFanout` fire-and-forget: đợi 1 tick để promise nội bộ reject và bị `.catch()` xử lý
    // trước khi assert — nếu lỗi không bị bắt, nó sẽ nổi lên như `unhandledRejection` thay vì bị
    // log ở đây.
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    console.log = originalLog;
  }

  assert.ok(loggedErr instanceof Error, "lỗi enqueue phải được catch và log, không bị nuốt im lặng hay throw ra ngoài");
});

after(async () => {
  await closeFanoutQueues();
});
