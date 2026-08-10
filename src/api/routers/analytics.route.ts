import { Router } from "express";
import { ANALYTICS_PATH } from "../../Breads-Shared/APIConfig.js";
import asyncHandler from "../../helpers/asyncHandler.js";
import { createEvent, getEvents } from "../controllers/analytics.controller.js";
import { validate } from "../middlewares/validate.js";
import { createEventSchema } from "../validators/analytics.validator.js";

const router = Router();

const { CREATE, GET } = ANALYTICS_PATH;

router.post(CREATE, validate(createEventSchema), asyncHandler(createEvent));
router.post(GET, asyncHandler(getEvents));

export default router;
