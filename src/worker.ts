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

try {
  initFanoutWorkers(undefined);
  logger.info("[fanout-queue] worker process started");
} catch (err) {
  logger.fatal({ err }, "[fanout-queue] initFanoutWorkers failed — worker process exiting");
  process.exit(1);
}

try {
  initFollowSuggestionWorker();
  logger.info("[follow-suggestion-queue] worker process started");
} catch (err) {
  logger.error({ err }, "[follow-suggestion-queue] initFollowSuggestionWorker failed — suggestion worker disabled, process continues");
}

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
