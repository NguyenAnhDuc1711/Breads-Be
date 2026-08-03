import { Router } from "express";
import { ANALYTICS_PATH } from "../../Breads-Shared/APIConfig.js";
import asyncHandler from "../../helpers/asyncHandler.js";
import { createEvent, getEvents } from "../controllers/analytics.controller.js";

const router = Router();

const { CREATE, GET } = ANALYTICS_PATH;

router.post(CREATE, asyncHandler(createEvent));
router.post(GET, asyncHandler(getEvents));

export default router;
