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
// Connect to MongoDB

instanceMongoDB.connect();
initRedis();
const app = express();

app.use(pinoHttp({ logger }));

// FR-2 (security-hardening, task 010): KHÔNG mount `express.json` global ở đây nữa. `body-parser`
// có hành vi parse-once (`req._body`) nên global 50mb sẽ làm mọi override nhỏ hơn phía sau thành
// no-op. Mỗi router tự mount `express.json({limit})` theo nhu cầu thật của mình.
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

// FR-1 (security-hardening, task 012): global-tier rate-limit (100 req/phút/IP) cho toàn bộ /api.
// Route auth-tier (SIGN_UP/LOGIN/CRAWL_POST/CRAWL_USER/forgot-password) có thêm authTierLimiter
// riêng ngay trên route đó (5 req/phút) — 2 lớp độc lập, lớp nghiêm ngặt hơn trigger trước.
app.use(API_PREFIX, globalTierLimiter, router);

app.use((req: Request, res: Response, next: NextFunction) => {
  const error = new Error("Not found");
  (error as any).status = 404;
  next(error as any);
});

// FR-2 (security-hardening, task 002): multer ném MulterError khi upload vượt limit cấu hình ở
// `middlewares/upload.ts` (fileSize/files) — message rõ ràng theo err.code, KHÔNG rơi vào nhánh
// generic 500 phía dưới.
const MULTER_ERROR_MESSAGES: Record<string, string> = {
  LIMIT_FILE_SIZE: "File quá lớn",
  LIMIT_FILE_COUNT: "Quá nhiều file trong 1 request",
};

app.use((err, req, res, next) => {
  const isDevEnv = process.env.NODE_ENV === "dev";
  // MulterError (FR-2, task 002) luôn trả 413, CHÈN TRƯỚC khi tính statusCode/message generic của
  // T001 — không sửa lại nhánh T001 phía dưới.
  const isMulterError = err instanceof multer.MulterError;
  const statusCode = isMulterError ? 413 : err.statusCode || err.status || 500;
  // Log server luôn ghi đầy đủ err/stack/message gốc, bất kể env — chỉ response ra client bị giới hạn.
  (req.log || logger).error({ err, statusCode }, err.message || "Unhandled request error");

  // "Lỗi nghiệp vụ đã biết" (BadRequestError, validate() middleware, ...) đều extend `ErrorResponse`
  // và tự soạn sẵn message an toàn để hiển thị — luôn giữ nguyên message của chúng.
  // Lỗi KHÔNG thuộc nhóm này (Mongoose, runtime khác) ở env != "dev" bị thay bằng message generic
  // theo statusCode (vd 404 -> "Not Found", 500 -> "Internal Server Error") để không lộ chi tiết nội bộ.
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
