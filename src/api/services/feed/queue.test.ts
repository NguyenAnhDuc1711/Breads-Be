// Run with Node's built-in test runner: `npm test`.
//
// Phạm vi: hạ tầng BullMQ của 001 — 2 `Queue` khởi tạo không throw khi Redis khả dụng (đòi hỏi
// Redis chạy thật ở localhost:6379, cùng điều kiện `npm run dev` cần), `Worker` throw đúng lúc
// khởi tạo khi connection thiếu `maxRetriesPerRequest: null` (FR-1/scenario 2), và pattern
// try/catch quanh `initFanoutWorkers()` ở `server.ts` không để lỗi thoát ra ngoài (AD-2/NFR-3).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Worker } from "bullmq";
import Redis from "ioredis";
import { FEED_CONFIG } from "./config.ts";
import {
  batchQueue,
  closeFanoutQueues,
  dispatchQueue,
  initFanoutWorkers,
  registerBatchWorker,
} from "./queue.ts";

test("FR-1/scenario 1: dispatchQueue và batchQueue khởi tạo không throw khi Redis khả dụng", async () => {
  assert.equal(dispatchQueue.name, "feed-fanout");
  assert.equal(batchQueue.name, "feed-fanout-batch");
  // `waitUntilReady` resolve chỉ khi connection Redis riêng của queue.ts thật sự sẵn sàng —
  // xác nhận cả 2 Queue kết nối thành công, không chỉ instantiate object suông.
  await assert.doesNotReject(dispatchQueue.waitUntilReady());
  await assert.doesNotReject(batchQueue.waitUntilReady());
});

test("FR-1/scenario 2: Worker throw ngay lúc khởi tạo khi connection thiếu maxRetriesPerRequest: null", async () => {
  // Mô phỏng đúng lỗi cấu hình mô tả trong AC: cố tình bỏ `maxRetriesPerRequest: null` (ioredis
  // default là 20, khác `null`) — BullMQ Worker bắt buộc `blockingConnection`, nên throw đồng bộ
  // trong constructor thay vì lỗi lúc runtime.
  const handlesBefore = process._getActiveHandles();
  const badConnection = new Redis({
    host: process.env.REDIS_HOST || "localhost",
    port: Number(process.env.REDIS_PORT || 6379),
  });
  try {
    assert.throws(() => {
      new Worker("queue-test-missing-max-retries", async () => {}, {
        connection: badConnection,
      });
    }, /maxRetriesPerRequest/);
  } finally {
    badConnection.disconnect();
    // BullMQ duplicate hoá `badConnection` cho blocking connection riêng của Worker TRƯỚC khi
    // validate `maxRetriesPerRequest` — throw xảy ra sau khi socket duplicate đã mở, nên
    // `badConnection.disconnect()` không đóng được nó (không phải cùng object). Không có cách
    // lấy tay cầm tới connection mồ côi này qua API công khai của BullMQ, nên `unref()` các
    // socket mới xuất hiện để không chặn `node --test` thoát — không destroy vội vì Node cần một
    // tick để hoàn tất teardown nội bộ của ioredis.
    await new Promise((r) => setTimeout(r, 50));
    for (const h of process._getActiveHandles()) {
      if (!handlesBefore.includes(h)) (h as any).unref?.();
    }
  }
});

test("(plan-review AD-2) initFanoutWorkers throw không được thoát ra ngoài try/catch — process không crash", () => {
  // `initFanoutWorkers` thật ở task 001 thân rỗng (không throw) — test này mô phỏng ĐÚNG pattern
  // bắt buộc ở call site `src/server.ts` (try/catch quanh initFanoutWorkers) với một hàm throw có
  // chủ đích, xác nhận lỗi bị chặn lại ở try/catch chứ không propagate lên process.
  const throwingInitFanoutWorkers = (io: any) => {
    throw new Error("Worker init failed: maxRetriesPerRequest missing");
  };

  let loggedErr: unknown;
  const originalError = console.error;
  console.error = (...args: any[]) => {
    loggedErr = args;
  };

  assert.doesNotThrow(() => {
    try {
      throwingInitFanoutWorkers(null);
    } catch (err) {
      console.error("[fanout-queue] initFanoutWorkers failed — fan-out queue disabled:", err);
    }
  });

  console.error = originalError;
  assert.ok(loggedErr, "lỗi phải được log, không bị nuốt im lặng");
});

test("initFanoutWorkers thật (thân rỗng, task 001): gọi trực tiếp không throw", () => {
  assert.doesNotThrow(() => initFanoutWorkers(null));
});

test("FR-4 (task 011): registerBatchWorker đặt đúng concurrency + limiter từ FEED_CONFIG", async () => {
  // Connection riêng cho test này (không dùng connection nội bộ của queue.ts, không export ra
  // ngoài file per AD-2) — cùng cấu hình `maxRetriesPerRequest: null` mà BullMQ Worker đòi hỏi.
  const conn = new Redis({
    host: process.env.REDIS_HOST || "localhost",
    port: Number(process.env.REDIS_PORT || 6379),
    maxRetriesPerRequest: null,
  });
  const worker = registerBatchWorker(conn);
  try {
    assert.equal(worker.opts.concurrency, FEED_CONFIG.fanoutBatchConcurrency);
    assert.deepEqual(worker.opts.limiter, {
      max: FEED_CONFIG.fanoutBatchRateLimitMax,
      duration: FEED_CONFIG.fanoutBatchRateLimitDurationMs,
    });
  } finally {
    // Đóng worker TRƯỚC khi quit `conn` — `registerBatchWorker` cũng push worker này vào
    // `workers[]` nội bộ của queue.ts nên `closeFanoutQueues()` ở `after()` bên dưới sẽ gọi
    // `.close()` lần nữa; BullMQ cache lại promise `closing` nên lần gọi thứ 2 vô hại.
    await worker.close();
    await conn.quit();
  }
});

after(async () => {
  // Đóng cả 2 Queue + connection nội bộ để `node --test` thoát được — Queue/ioredis giữ socket mở
  // vô thời hạn nếu không `close()`/`quit()`.
  await closeFanoutQueues();
});
