import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { FEED_CONFIG } from "./config.ts";
import { processDispatchJob } from "./fanout.ts";

/**
 * Connection BullMQ riêng, KHÔNG dùng chung `getRedisInstance()` (`src/dbs/redis.ts`).
 * BullMQ bắt buộc `maxRetriesPerRequest: null` — khác hẳn `enableOfflineQueue: false` mà
 * connection chính dùng để fail-fast cho các helper `zset.ts`. Không export instance này ra
 * ngoài file (AD-2 của epic) — task khác chỉ cần `dispatchQueue`/`batchQueue`/`initFanoutWorkers`.
 */
const connection = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null,
});

export const dispatchQueue = new Queue("feed-fanout", { connection });
export const batchQueue = new Queue("feed-fanout-batch", { connection });

/** Worker đã đăng ký — chỉ để `closeFanoutQueues()` đóng được chúng. `Worker` giữ một blocking
 * connection riêng (BullMQ tự duplicate) mà `connection.quit()` KHÔNG chạm tới, nên thiếu bước này
 * `node --test` treo sau khi một test gọi `initFanoutWorkers()`. */
const workers: Worker[] = [];

/**
 * Worker tầng dispatch — 1 job / post, chạy `processDispatchJob` (phân loại, chunk, addBulk,
 * socket). `concurrency` giới hạn số POST xử lý song song; nó cố ý KHÔNG phải chỗ throttle Redis
 * (AD-1) — throttle thật là `limiter` của batch worker (task 011).
 */
export const registerDispatchWorker = (io: any, conn: Redis): Worker => {
  const worker = new Worker(
    "feed-fanout",
    async (job) => processDispatchJob(job.data, io),
    { connection: conn, concurrency: FEED_CONFIG.fanoutQueueConcurrency },
  );
  workers.push(worker);
  return worker;
};

/**
 * Đăng ký worker cho cả 2 queue. Task 011 thêm `registerBatchWorker(connection)` vào đây.
 *
 * Call site (`src/server.ts`) BẮT BUỘC bọc try/catch: nếu `Worker` constructor throw (vd thiếu
 * `maxRetriesPerRequest: null`), lỗi không được crash app boot (AD-2, NFR-3 "Redis down ≠ app
 * down").
 */
export const initFanoutWorkers = (io: any): void => {
  registerDispatchWorker(io, connection);
  // task 011 gọi registerBatchWorker(connection)
};

/**
 * Đóng cả 2 `Queue` và connection nội bộ — dùng cho teardown test (`queue.test.ts`) và graceful
 * shutdown nếu cần sau này. `Queue.close()` chỉ đóng connection DUPLICATE mà BullMQ tự tạo khi
 * nhận một `ioredis` instance có sẵn, không đóng `connection` gốc — phải `quit()` riêng để tiến
 * trình `node --test` thoát được thay vì treo vì socket còn mở.
 */
export const closeFanoutQueues = async (): Promise<void> => {
  await Promise.all(workers.splice(0).map((w) => w.close()));
  await Promise.all([dispatchQueue.close(), batchQueue.close()]);
  await connection.quit();
};
