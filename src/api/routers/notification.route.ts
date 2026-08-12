import express from "express";
import mongoSanitize from "express-mongo-sanitize";
import hpp from "hpp";
import { NOTIFICATION_PATH } from "../../Breads-Shared/APIConfig.js";
import asyncHandler from "../../helpers/asyncHandler.js";
import { getNotifications } from "../controllers/notification.controller.js";
import protectRoute from "../middlewares/protectRoute.js";
import { validate } from "../middlewares/validate.ts";
import { getNotificationsSchema } from "../validators/notification.validator.ts";

const router = express.Router();
// FR-2 (task 010): chỉ nhận userId/paging, không có field lớn -> 1mb.
router.use(express.json({ limit: "1mb" }));
// FR-5 (task 013): sanitize NoSQL operator + HPP.
router.use(mongoSanitize());
router.use(hpp());
// FR-1 (epic notification-fixes, AD-2): guard ở ROUTER level, không mount lẻ theo route — mọi
// route hiện tại và tương lai của router này fail-closed. Router này không có route public nào.
router.use(protectRoute);

router.post(
  NOTIFICATION_PATH.GET,
  validate(getNotificationsSchema),
  asyncHandler(getNotifications)
);

export default router;
