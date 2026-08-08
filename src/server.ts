import "dotenv/config";
import app from "./app.ts";
import { initSocket } from "./socket/socket.ts";

const PORT = Number(process.env.PORT) || 8080;
const HOST = "0.0.0.0";

const server = app.listen(PORT, HOST, () => {
  console.log(`Server started at on port:${PORT}`);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[fatal] Port ${PORT} đã bị chiếm bởi process khác — server (và socket) không thể khởi động. Hãy tắt process đang giữ port ${PORT} rồi chạy lại.`
    );
    process.exit(1);
  }
  throw err;
});

initSocket(server, app);

process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException:", err?.stack || err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandledRejection:", (reason as any)?.stack || reason);
});

process.on("SIGINT", () => {
  server.getConnections((err, count) => {
    console.log("Open connections:", count);
  });
  server.close(() => {
    console.log("All connections closed");
  });
  process.exit(1);
});
