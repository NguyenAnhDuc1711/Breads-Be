import pino from "pino";

const isDevEnv = process.env.NODE_ENV === "dev";

const logger = pino({
  level: process.env.LOG_LEVEL || (isDevEnv ? "debug" : "info"),
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
