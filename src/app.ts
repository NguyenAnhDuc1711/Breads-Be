import { STATUS_CODES } from "node:http";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import multer from "multer";
import pinoHttp from "pino-http";
import router from "./api/routers/index.js";
import { updateUsersCatesCron } from "./cronjob/index.js";
import instanceMongoDB from "./dbs/mongodb.ts";
import initRedis from "./dbs/redis.ts";
import { metricsHandler, metricsMiddleware } from "./api/middlewares/metrics.ts";
import { globalTierLimiter } from "./api/middlewares/rateLimiter.ts";
import { API_PREFIX } from "./Breads-Shared/APIConfig.js";
import ALLOWED_ORIGINS from "./utils/allowedOrigins.ts";
import { ErrorResponse } from "./core/error.response.ts";
import logger from "./core/logger.ts";

instanceMongoDB.connect();
initRedis();
const app = express();

const isDevEnv = process.env.NODE_ENV === "dev";
app.use(pinoHttp({ logger, autoLogging: !isDevEnv }));

app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(helmet());
const corOption = {
  origin: ALLOWED_ORIGINS,
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
  preflightContinue: false,
  optionsSuccessStatus: 204,
  credentials: true,
};
app.use(cors(corOption));

app.use(metricsMiddleware);
app.get("/metrics", metricsHandler);

app.use(API_PREFIX, globalTierLimiter, router);

app.use((req: Request, res: Response, next: NextFunction) => {
  const error = new Error("Not found");
  (error as any).status = 404;
  next(error as any);
});

const MULTER_ERROR_MESSAGES: Record<string, string> = {
  LIMIT_FILE_SIZE: "File quá lớn",
  LIMIT_FILE_COUNT: "Quá nhiều file trong 1 request",
};

app.use((err, req, res, next) => {
  const isDevEnv = process.env.NODE_ENV === "dev";
  const isMulterError = err instanceof multer.MulterError;
  const statusCode = isMulterError ? 413 : err.statusCode || err.status || 500;
  (req.log || logger).error({ err, statusCode }, err.message || "Unhandled request error");

  const isKnownBusinessError = err instanceof ErrorResponse;
  const message = isMulterError
    ? MULTER_ERROR_MESSAGES[err.code] || err.message || "Lỗi upload file"
    : isDevEnv || isKnownBusinessError
      ? err.message || "Internal Server Error"
      : STATUS_CODES[statusCode] || "Internal Server Error";

  const response = {
    status: "error",
    code: statusCode,
    message,
  };
  if (isDevEnv) {
    (response as any).stack = err.stack;
  }
  return res.status(statusCode).json(response);
});

updateUsersCatesCron();
export default app;
