import express from "express";
import { NOTIFICATION_PATH } from "../../Breads-Shared/APIConfig.js";
import asyncHandler from "../../helpers/asyncHandler.js";
import { getNotifications } from "../controllers/notification.controller.js";
import { validate } from "../middlewares/validate.ts";
import { getNotificationsSchema } from "../validators/notification.validator.ts";

const router = express.Router();

router.post(
  NOTIFICATION_PATH.GET,
  validate(getNotificationsSchema),
  asyncHandler(getNotifications)
);

export default router;
