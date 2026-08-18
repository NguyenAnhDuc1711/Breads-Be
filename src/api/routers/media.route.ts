import express from "express";
import mongoSanitize from "express-mongo-sanitize";
import hpp from "hpp";
import { MEDIA_PATH } from "../../Breads-Shared/APIConfig.js";
import asyncHandler from "../../helpers/asyncHandler.js";
import { signUpload } from "../controllers/media.controller.js";
import protectRoute from "../middlewares/protectRoute.js";
import { mediaSignLimiter } from "../middlewares/rateLimiter.js";
import { validate } from "../middlewares/validate.js";
import { mediaSignSchema } from "../validators/media.validator.js";

const router = express.Router();
// 100kb, KHÔNG phải 50mb như post/report router: payload ở đây chỉ là
// `{entityType, count, recipientId?, items?}` — không còn bytes nhị phân nào đi qua backend, đó
// chính là điểm của cả epic này.
router.use(express.json({ limit: "100kb" }));
router.use(mongoSanitize());
router.use(hpp());

// Thứ tự middleware: protectRoute (NFR-4 — không cấp chữ ký ẩn danh) -> mediaSignLimiter (FR-6) ->
// validate. `globalTierLimiter` ở `app.ts` vẫn là lớp bao ngoài cho traffic chưa auth.
router.post(
  MEDIA_PATH.SIGN_UPLOAD,
  protectRoute,
  mediaSignLimiter,
  validate(mediaSignSchema),
  asyncHandler(signUpload),
);

export default router;
