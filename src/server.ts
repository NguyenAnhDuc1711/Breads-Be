import "dotenv/config";
import app from "./app.ts";
import { initSocket } from "./socket/socket.ts";

const PORT = process.env.PORT || 8080;

const server = app.listen(PORT, () => {
  console.log(`Server started at on port:${PORT}`);
});

initSocket(server, app);

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception: ", err);
  process.exit(1);
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
