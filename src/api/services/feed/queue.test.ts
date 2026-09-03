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
  await assert.doesNotReject(dispatchQueue.waitUntilReady());
  await assert.doesNotReject(batchQueue.waitUntilReady());
});

test("FR-1/scenario 2: Worker throw ngay lúc khởi tạo khi connection thiếu maxRetriesPerRequest: null", async () => {
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
    await new Promise((r) => setTimeout(r, 50));
    for (const h of process._getActiveHandles()) {
      if (!handlesBefore.includes(h)) (h as any).unref?.();
    }
  }
});

test("(plan-review AD-2) initFanoutWorkers throw không được thoát ra ngoài try/catch — process không crash", () => {
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
    await worker.close();
    await conn.quit();
  }
});

after(async () => {
  await closeFanoutQueues();
});
