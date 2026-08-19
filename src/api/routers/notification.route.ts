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
// FR-2 (task 010): chỉ nhận userId/paging, không có field lớn -> 1mb.
router.use(express.json({ limit: "1mb" }));
// FR-5 (task 013): sanitize NoSQL operator + HPP.
router.use(mongoSanitize());
router.use(hpp());
// FR-1 (epic notification-fixes, AD-2): guard ở ROUTER level, không mount lẻ theo route — mọi
// route hiện tại và tương lai của router này fail-closed. Router này không có route public nào.
router.use(protectRoute);

// Task 013 (D-1): list -> GET (đổi từ POST /get). page/limit/action đọc từ query.
router.get(
  NOTIFICATION_PATH.GET,
  validate(getNotificationsSchema),
  asyncHandler(getNotifications)
);

// FR-3 (task 010): PATCH, chốt bởi chủ dự án (UD-4) — không đăng ký POST /read song song.
// KHÔNG mount guard đăng nhập lần nữa ở đây: đã mount ở router level phía trên (AD-2).
router.patch(
  NOTIFICATION_PATH.READ,
  validate(readNotificationsSchema),
  asyncHandler(readNotifications)
);

export default router;
