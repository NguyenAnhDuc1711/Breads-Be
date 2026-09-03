import "dotenv/config";
import mongoose from "mongoose";
import app from "./app.ts";
import { initSocket } from "./socket/socket.ts";
import { closeFanoutQueues } from "./api/services/feed/queue.ts";
import { getRedisInstance } from "./dbs/redis.ts";
import logger from "./core/logger.ts";

const PORT = Number(process.env.PORT) || 8080;
const HOST = "0.0.0.0";

const server = app.listen(PORT, HOST, () => {
  logger.info(`Server started at on port:${PORT}`);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    logger.fatal(
      `Port ${PORT} đã bị chiếm bởi process khác — server (và socket) không thể khởi động. Hãy tắt process đang giữ port ${PORT} rồi chạy lại.`
    );
    process.exit(1);
  }
  throw err;
});

initSocket(server, app);

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaughtException");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "unhandledRejection");
});

const shutdown = (signal: string) => {
  logger.info(`${signal} received — starting graceful shutdown`);

  const forceExitTimer = setTimeout(() => {
    logger.fatal("Graceful shutdown timed out — forcing exit");
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref();

  server.close(async (err) => {
    if (err) {
      logger.error({ err }, "Error while closing HTTP server");
    } else {
      logger.info("HTTP server closed");
    }

    try {
      await closeFanoutQueues();
    } catch (closeErr) {
      logger.error({ err: closeErr }, "Error closing fanout queues");
    }

    try {
      await getRedisInstance()?.quit();
    } catch (closeErr) {
      logger.error({ err: closeErr }, "Error closing Redis connection");
    }

    try {
      await mongoose.connection.close();
    } catch (closeErr) {
      logger.error({ err: closeErr }, "Error closing MongoDB connection");
    }

    clearTimeout(forceExitTimer);
    process.exit(0);
  });
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
