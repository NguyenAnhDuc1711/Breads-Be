import "dotenv/config";
import mongoose from "mongoose";
import instanceMongoDB from "./dbs/mongodb.ts";
import initRedis, { getRedisInstance } from "./dbs/redis.ts";
import { initFanoutWorkers, closeFanoutQueues } from "./api/services/feed/queue.ts";
import {
  initFollowSuggestionWorker,
  closeFollowSuggestionQueue,
} from "./api/services/followSuggestion/queue.ts";
import { initFollowSuggestionCron } from "./api/services/followSuggestion/cron.ts";
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

// [follow-suggestion-queue task 010] try/catch RIÊNG, KHÔNG gộp với khối phía trên (AD-2 epic.md,
// task 010 AC "isolation"): feed-fanout là chức năng chính (mất nó -> process.exit), suggestion
// worker là phụ trợ — lỗi khởi tạo (vd Redis down) chỉ log, không được kéo theo crash cả process
// lẫn feed-fanout worker đã khởi tạo thành công ở trên.
try {
  initFollowSuggestionWorker();
  logger.info("[follow-suggestion-queue] worker process started");
} catch (err) {
  logger.error({ err }, "[follow-suggestion-queue] initFollowSuggestionWorker failed — suggestion worker disabled, process continues");
}

// [follow-suggestion-cron task 012] Cùng subsystem/cùng mức độ "phụ trợ" như worker phía trên —
// đặt trong try/catch RIÊNG (không gộp) để lỗi lịch cron không kéo theo lỗi worker và ngược lại.
// initFollowSuggestionCron() không có trong "files:" của task 012.md (chỉ scope cron.ts) nên chưa
// từng được wire vào bootstrap nào — bổ sung ở đây, chỗ tự nhiên duy nhất (giống initFanoutWorkers/
// initFollowSuggestionWorker phía trên), để cron thực sự chạy thay vì chỉ tồn tại dưới dạng hàm
// export chưa ai gọi.
let followSuggestionCronTask: ReturnType<typeof initFollowSuggestionCron> | undefined;
try {
  followSuggestionCronTask = initFollowSuggestionCron();
  logger.info("[follow-suggestion-cron] cron scheduled");
} catch (err) {
  logger.error({ err }, "[follow-suggestion-cron] initFollowSuggestionCron failed — refresh cron disabled, process continues");
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
      followSuggestionCronTask?.stop();
    } catch (err) {
      logger.error({ err }, "Error stopping follow-suggestion cron");
    }

    try {
      await closeFollowSuggestionQueue();
    } catch (err) {
      logger.error({ err }, "Error closing follow-suggestion queue");
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
