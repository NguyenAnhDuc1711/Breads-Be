import express from "express";
import { NOTIFICATION_PATH } from "../../Breads-Shared/APIConfig.js";
import asyncHandler from "../../helpers/asyncHandler.js";
import { getNotifications } from "../controllers/notification.controller.js";

const router = express.Router();

router.post(NOTIFICATION_PATH.GET, asyncHandler(getNotifications));

export default router;
