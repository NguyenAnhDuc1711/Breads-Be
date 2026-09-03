import express from "express";
import mongoSanitize from "express-mongo-sanitize";
import hpp from "hpp";
import { NOTIFICATION_PATH } from "../../Breads-Shared/APIConfig.js";
import asyncHandler from "../../helpers/asyncHandler.js";
import {
  getNotifications,
  readNotifications,
} from "../controllers/notification.controller.js";
import protectRoute from "../middlewares/protectRoute.js";
import { validate } from "../middlewares/validate.ts";
import {
  getNotificationsSchema,
  readNotificationsSchema,
} from "../validators/notification.validator.ts";

const router = express.Router();
router.use(express.json({ limit: "1mb" }));
router.use(mongoSanitize());
router.use(hpp());
router.use(protectRoute);

router.get(
  NOTIFICATION_PATH.GET,
  validate(getNotificationsSchema),
  asyncHandler(getNotifications)
);

router.patch(
  NOTIFICATION_PATH.READ,
  validate(readNotificationsSchema),
  asyncHandler(readNotifications)
);

export default router;
