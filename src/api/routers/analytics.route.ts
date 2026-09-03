import express, { Router } from "express";
import mongoSanitize from "express-mongo-sanitize";
import hpp from "hpp";
import { ANALYTICS_PATH } from "../../Breads-Shared/APIConfig.js";
import asyncHandler from "../../helpers/asyncHandler.js";
import { createEvent, getEvents } from "../controllers/analytics.controller.js";
import { validate } from "../middlewares/validate.js";
import { createEventSchema } from "../validators/analytics.validator.js";

const router = Router();
router.use(express.json({ limit: "1mb" }));
router.use(mongoSanitize());
router.use(hpp());

const { CREATE, GET } = ANALYTICS_PATH;

router.post(CREATE, validate(createEventSchema), asyncHandler(createEvent));
router.get(GET, asyncHandler(getEvents));

export default router;
