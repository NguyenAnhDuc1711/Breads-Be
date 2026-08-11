import { STATUS_CODES } from "node:http";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import router from "./api/routers/index.js";
import {
  createDailyCollectionCron,
  updateUsersCatesCron,
} from "./cronjob/index.js";
import instanceMongoDB from "./dbs/mongodb.ts";
import initRedis from "./dbs/redis.ts";
import { metricsHandler, metricsMiddleware } from "./api/middlewares/metrics.ts";
import ALLOWED_ORIGINS from "./utils/allowedOrigins.ts";
import { ErrorResponse } from "./core/error.response.ts";
import logger from "./core/logger.ts";
// Connect to MongoDB

instanceMongoDB.connect();
initRedis();
const app = express();

app.use(pinoHttp({ logger }));

app.use(express.json({ limit: "50mb" })); // to prase  Json data in the req.body
app.use(express.urlencoded({ extended: false })); // to prase from data in the req.body
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

app.use("/api", router);

app.use((req: Request, res: Response, next: NextFunction) => {
  const error = new Error("Not found");
  (error as any).status = 404;
  next(error as any);
});

app.use((err, req, res, next) => {
  const isDevEnv = process.env.NODE_ENV === "dev";
  const statusCode = err.statusCode || err.status || 500;
  // Log server luôn ghi đầy đủ err/stack/message gốc, bất kể env — chỉ response ra client bị giới hạn.
  (req.log || logger).error({ err, statusCode }, err.message || "Unhandled request error");

  // "Lỗi nghiệp vụ đã biết" (BadRequestError, validate() middleware, ...) đều extend `ErrorResponse`
  // và tự soạn sẵn message an toàn để hiển thị — luôn giữ nguyên message của chúng.
  // Lỗi KHÔNG thuộc nhóm này (Mongoose, runtime khác) ở env != "dev" bị thay bằng message generic
  // theo statusCode (vd 404 -> "Not Found", 500 -> "Internal Server Error") để không lộ chi tiết nội bộ.
  const isKnownBusinessError = err instanceof ErrorResponse;
  const message =
    isDevEnv || isKnownBusinessError
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

createDailyCollectionCron();
updateUsersCatesCron();
export default app;
