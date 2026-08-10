import pino from "pino";

// Cùng convention `NODE_ENV === "dev"` đã dùng ở app.ts cho stack trace trong response.
const isDevEnv = process.env.NODE_ENV === "dev";

const logger = pino({
  level: process.env.LOG_LEVEL || (isDevEnv ? "debug" : "info"),
  // dev: pretty-print có màu cho người đọc trực tiếp terminal.
  // prod: JSON thô ra stdout — đúng định dạng để log driver/aggregator (Docker, Loki...) parse.
  transport: isDevEnv
    ? {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:standard" },
      }
    : undefined,
  serializers: {
    err: pino.stdSerializers.err,
  },
});

export default logger;
