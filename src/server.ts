import "dotenv/config";
import app from "./app.ts";
import { initSocket } from "./socket/socket.ts";
import { initFanoutWorkers } from "./api/services/feed/queue.ts";
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

// [fanout-queue AD-2] initFanoutWorkers khởi tạo 2 BullMQ Worker (dispatch/batch) chạy
// in-process. Bọc try/catch bắt buộc: nếu Worker constructor throw (vd thiếu
// `maxRetriesPerRequest: null`), lỗi chỉ vô hiệu hoá fan-out queue — KHÔNG được crash app boot
// (NFR-3 "Redis down ≠ app down").
try {
  initFanoutWorkers(app.get("socket_io"));
} catch (err) {
  logger.error({ err }, "[fanout-queue] initFanoutWorkers failed — fan-out queue disabled");
}

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaughtException");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "unhandledRejection");
});

process.on("SIGINT", () => {
  server.getConnections((err, count) => {
    logger.info(`Open connections: ${count}`);
  });
  server.close(() => {
    logger.info("All connections closed");
  });
  process.exit(1);
});
