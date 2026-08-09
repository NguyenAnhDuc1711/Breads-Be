import { Queue } from "bullmq";
import Redis from "ioredis";

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

/**
 * Đăng ký worker cho cả 2 queue. Thân rỗng ở task 001 — task 010 gọi
 * `registerDispatchWorker(io, connection)`, task 011 gọi `registerBatchWorker(connection)` bên
 * trong hàm này.
 *
 * Call site (`src/server.ts`) BẮT BUỘC bọc try/catch: nếu `Worker` constructor throw (vd thiếu
 * `maxRetriesPerRequest: null`), lỗi không được crash app boot (AD-2, NFR-3 "Redis down ≠ app
 * down").
 */
export const initFanoutWorkers = (io: any): void => {
  // task 010 gọi registerDispatchWorker(io, connection)
  // task 011 gọi registerBatchWorker(connection)
};

/**
 * Đóng cả 2 `Queue` và connection nội bộ — dùng cho teardown test (`queue.test.ts`) và graceful
 * shutdown nếu cần sau này. `Queue.close()` chỉ đóng connection DUPLICATE mà BullMQ tự tạo khi
 * nhận một `ioredis` instance có sẵn, không đóng `connection` gốc — phải `quit()` riêng để tiến
 * trình `node --test` thoát được thay vì treo vì socket còn mở.
 */
export const closeFanoutQueues = async (): Promise<void> => {
  await Promise.all([dispatchQueue.close(), batchQueue.close()]);
  await connection.quit();
};
