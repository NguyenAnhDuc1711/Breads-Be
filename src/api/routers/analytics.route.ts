import express, { Router } from "express";
import { ANALYTICS_PATH } from "../../Breads-Shared/APIConfig.js";
import asyncHandler from "../../helpers/asyncHandler.js";
import { createEvent, getEvents } from "../controllers/analytics.controller.js";
import { validate } from "../middlewares/validate.js";
import { createEventSchema } from "../validators/analytics.validator.js";

const router = Router();
// FR-2 (task 010): deviceInfo/browserInfo là metadata nhỏ, không phải media -> 1mb.
router.use(express.json({ limit: "1mb" }));

const { CREATE, GET } = ANALYTICS_PATH;

router.post(CREATE, validate(createEventSchema), asyncHandler(createEvent));
router.post(GET, asyncHandler(getEvents));

export default router;
