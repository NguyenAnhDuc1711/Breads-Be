import express from "express";
import {
  changePassword,
  checkValidUser,
  followUser,
  getAdminAccount,
  getMe,
  getUserIdFromEmail,
  getUserProfile,
  getUsersFollow,
  getUsersToTag,
  getUserToFollows,
  handleCrawlFakeUsers,
  loginUser,
  logoutUser,
  signupUser,
  updateUser,
  getUsersPendingPost,
  getUsersWithStatus,
  validateEmailByCode,
} from "../controllers/user.controller.js";
import { USER_PATH } from "../../Breads-Shared/APIConfig.js";
import protectRoute from "../middlewares/protectRoute.js";
import asyncHandler from "../../helpers/asyncHandler.js";
import { validate } from "../middlewares/validate.js";
import { authTierLimiter } from "../middlewares/rateLimiter.js";
import {
  getUserProfileSchema,
  signupUserSchema,
  loginUserSchema,
  followUserSchema,
  updateUserSchema,
  changePasswordSchema,
  validateEmailByCodeSchema,
  getUsersFollowQuerySchema,
  getUserToFollowsQuerySchema,
  getUsersToTagQuerySchema,
  getUsersWithStatusQuerySchema,
  getUsersPendingPostSchema,
  checkValidUserSchema,
  getUserIdFromEmailSchema,
} from "../validators/user.validator.js";

// FR-2 (Task 011): router DUY NHẤT lẫn 2 nhóm payload trong cùng 1 file — nhóm auth/text nhỏ
// (100kb) và route avatar base64 (50mb). Vì vậy CỐ Ý không mount body-parser ở cấp router như
// 7 router kia (Task 010): mount per-route để avatar không kéo cả nhóm auth lên 50mb, và
// nhóm auth không hạ avatar xuống 100kb. 9/18 route đọc `req.body` đều PHẢI có `express.json`
// đứng đầu chain; 9 route còn lại (GET listing + LOGOUT + CRAWL_USER) không đọc body -> không mount.
const router = express.Router();
const {
  ME,
  ADMIN,
  PROFILE,
  USERS_TO_FOLLOW,
  SIGN_UP,
  LOGIN,
  LOGOUT,
  FOLLOW,
  UPDATE,
  CHANGE_PW,
  CRAWL_USER,
  USERS_FOLLOW,
  USERS_TO_TAG,
  CHECK_VALID_USER,
  GET_USER_ID_FROM_EMAIL,
  GET_USERS_PENDING_POST,
  GET_USERS_WITH_STATUS,
  VALIDATE_USER_EMAIL,
} = USER_PATH;

router.get(ME, protectRoute, asyncHandler(getMe));
router.get(
  USERS_FOLLOW,
  validate(getUsersFollowQuerySchema),
  asyncHandler(getUsersFollow)
);
router.get(ADMIN, asyncHandler(getAdminAccount));
router.get(
  PROFILE + ":userId",
  validate(getUserProfileSchema),
  asyncHandler(getUserProfile)
);
router.get(
  USERS_TO_FOLLOW,
  validate(getUserToFollowsQuerySchema),
  asyncHandler(getUserToFollows)
);
router.get(
  USERS_TO_TAG,
  protectRoute,
  validate(getUsersToTagQuerySchema),
  asyncHandler(getUsersToTag)
);
router.get(
  GET_USERS_WITH_STATUS,
  validate(getUsersWithStatusQuerySchema),
  asyncHandler(getUsersWithStatus)
);
router.post(
  GET_USERS_PENDING_POST,
  express.json({ limit: "100kb" }),
  validate(getUsersPendingPostSchema),
  asyncHandler(getUsersPendingPost)
);
router.post(
  SIGN_UP,
  express.json({ limit: "100kb" }),
  authTierLimiter,
  validate(signupUserSchema),
  asyncHandler(signupUser)
);
router.post(
  LOGIN,
  express.json({ limit: "100kb" }),
  authTierLimiter,
  validate(loginUserSchema),
  asyncHandler(loginUser)
);
router.post(LOGOUT, asyncHandler(logoutUser));
router.put(
  FOLLOW,
  express.json({ limit: "100kb" }),
  protectRoute,
  validate(followUserSchema),
  asyncHandler(followUser)
);
// Route DUY NHẤT của router này cần limit lớn: `updateUser` nhận avatar base64 và đẩy sang
// `uploadFileFromBase64` (user.controller.ts:226). KHÔNG được gộp chung limit 100kb của nhóm auth.
router.put(
  UPDATE + ":id",
  express.json({ limit: "50mb" }),
  protectRoute,
  validate(updateUserSchema),
  asyncHandler(updateUser)
);
router.put(
  CHANGE_PW + ":id",
  express.json({ limit: "100kb" }),
  validate(changePasswordSchema),
  asyncHandler(changePassword)
);
// AD-3 (task 012): CRAWL_USER thiếu auth guard (PRD C-4) -> áp auth-tier nghiêm ngặt thay vì loại
// trừ khỏi rate-limit, vì đây là endpoint tốn tài nguyên (trigger seed).
router.post(CRAWL_USER, authTierLimiter, asyncHandler(handleCrawlFakeUsers));
router.post(
  CHECK_VALID_USER,
  express.json({ limit: "100kb" }),
  validate(checkValidUserSchema),
  asyncHandler(checkValidUser)
);
router.post(
  GET_USER_ID_FROM_EMAIL,
  express.json({ limit: "100kb" }),
  validate(getUserIdFromEmailSchema),
  asyncHandler(getUserIdFromEmail)
);
router.post(
  VALIDATE_USER_EMAIL,
  express.json({ limit: "100kb" }),
  validate(validateEmailByCodeSchema),
  asyncHandler(validateEmailByCode)
);

export default router;
