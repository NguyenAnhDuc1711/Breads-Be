import express, { Router } from "express";
import mongoSanitize from "express-mongo-sanitize";
import hpp from "hpp";
import { ANALYTICS_PATH } from "../../Breads-Shared/APIConfig.js";
import asyncHandler from "../../helpers/asyncHandler.js";
import { createEvent, getEvents } from "../controllers/analytics.controller.js";
import { validate } from "../middlewares/validate.js";
import { createEventSchema } from "../validators/analytics.validator.js";

const router = Router();
// FR-2 (task 010): deviceInfo/browserInfo là metadata nhỏ, không phải media -> 1mb.
router.use(express.json({ limit: "1mb" }));
// FR-5 (task 013): sanitize NoSQL operator + HPP.
router.use(mongoSanitize());
router.use(hpp());

const { CREATE, GET } = ANALYTICS_PATH;

router.post(CREATE, validate(createEventSchema), asyncHandler(createEvent));
// Task 013 (D-1): list -> GET. getEvents không đọc field nào từ body (xem controller) nên không
// cần schema/coerce gì thêm khi đổi method.
router.get(GET, asyncHandler(getEvents));

export default router;
