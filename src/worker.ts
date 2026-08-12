import "dotenv/config";
import mongoose from "mongoose";
import instanceMongoDB from "./dbs/mongodb.ts";
import initRedis, { getRedisInstance } from "./dbs/redis.ts";
import { initFanoutWorkers, closeFanoutQueues } from "./api/services/feed/queue.ts";
import logger from "./core/logger.ts";

instanceMongoDB.connect();
initRedis();

// [fanout-queue A3] Process riêng cho BullMQ Worker (dispatch/batch), tách khỏi HTTP server
// (src/server.ts) để scale độc lập theo queue depth thay vì cạnh tranh CPU/event-loop với việc
// phục vụ HTTP. Không có Socket.IO ở đây nên truyền `io = undefined`: nhánh push real-time
// (`FEED_CONFIG.socketEnabled`, xem fanout.ts) tự bỏ qua khi thiếu `io` — chỉ mất tính năng push
// real-time "bài viết mới" (mặc định tắt, off theo `FEED_SOCKET_ENABLED`), fan-out ghi ZSET vẫn
// chạy bình thường. Muốn giữ push real-time khi tách process cần Redis adapter cho Socket.IO (A1)
// làm cầu nối giữa 2 process.
try {
  initFanoutWorkers(undefined);
  logger.info("[fanout-queue] worker process started");
} catch (err) {
  logger.fatal({ err }, "[fanout-queue] initFanoutWorkers failed — worker process exiting");
  process.exit(1);
}

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaughtException");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "unhandledRejection");
});

const shutdown = (signal: string) => {
  logger.info(`${signal} received — shutting down worker`);

  const forceExitTimer = setTimeout(() => {
    logger.fatal("Worker shutdown timed out — forcing exit");
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref();

  (async () => {
    try {
      await closeFanoutQueues();
    } catch (err) {
      logger.error({ err }, "Error closing fanout queues");
    }

    try {
      await getRedisInstance()?.quit();
    } catch (err) {
      logger.error({ err }, "Error closing Redis connection");
    }

    try {
      await mongoose.connection.close();
    } catch (err) {
      logger.error({ err }, "Error closing MongoDB connection");
    }

    clearTimeout(forceExitTimer);
    process.exit(0);
  })();
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
