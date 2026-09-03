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
router.use(express.json({ limit: "100kb" }));
router.use(mongoSanitize());
router.use(hpp());

router.post(
  MEDIA_PATH.SIGN_UPLOAD,
  protectRoute,
  mediaSignLimiter,
  validate(mediaSignSchema),
  asyncHandler(signUpload),
);

export default router;
