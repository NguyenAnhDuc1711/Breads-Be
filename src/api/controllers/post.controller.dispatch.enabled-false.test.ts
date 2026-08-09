// Run with Node's built-in test runner: `npm test`.
//
// Phạm vi: Task 012 (`dispatchFanout`) — FR-2/scenario 2: `FEED_FANOUT_ENABLED=false` (mode vẫn
// mặc định "queue", KHÔNG set `FEED_FANOUT_MODE`) -> không job nào được enqueue VÀ
// `fanoutPostToFollowers` cũng không được gọi (chỉ nhánh `mode==="direct"` mới gọi hàm đó, nhánh
// này không phải "direct").
//
// `FEED_CONFIG` đọc `process.env` đúng 1 lần lúc `config.ts` được import rồi `Object.freeze` —
// phải set env TRƯỚC bất kỳ import chạm tới `config.ts` (qua `post.controller.ts` ->
// `queue.ts`/`fanout.ts`). `node --test` chạy mỗi file test trong 1 process riêng nên set ở đây
// không rò sang file test khác (cùng lý do đã áp dụng ở `fanout.dispatch.test.ts`).
//
// QUAN TRỌNG: import TĨNH bị hoist lên TRƯỚC dòng `process.env...` phía dưới, bất kể thứ tự viết
// trong file — nên MỌI import chạm tới `config.ts` (kể cả gián tiếp qua `queue.ts` để lấy
// `closeFanoutQueues`) phải là `await import(...)` động bên trong test/hook, không được là import
// tĩnh ở đầu file. Đây chính là bẫy mà bản đầu tiên của file này mắc phải (import tĩnh
// `closeFanoutQueues` khiến `config.ts` nạp với env mặc định trước khi override kịp áp dụng).
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
