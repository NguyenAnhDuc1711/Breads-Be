import express from "express";
import mongoSanitize from "express-mongo-sanitize";
import hpp from "hpp";
import {
  changePassword,
  followUser,
  getMe,
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
  getSitemapEligibleUsers,
  validateEmailByCode,
  refreshTokenHandler,
  getUserAdminDetail,
  adminUpdateUser,
  requestPasswordReset,
  verifyPasswordResetCode,
  confirmPasswordReset,
} from "../controllers/user.controller.js";
import { USER_PATH } from "../../Breads-Shared/APIConfig.js";
import { Constants } from "../../Breads-Shared/Constants/index.js";
import protectRoute from "../middlewares/protectRoute.js";
import { requireRole, requireSelfOrRole } from "../middlewares/requireRole.js";
import asyncHandler from "../../helpers/asyncHandler.js";
import { validate } from "../middlewares/validate.js";
import { authTierLimiter } from "../middlewares/rateLimiter.js";
import sitemapAuthGate from "../middlewares/sitemapAuthGate.js";
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
  getSitemapEligibleUsersQuerySchema,
  getUserAdminDetailSchema,
  adminUpdateUserSchema,
  requestPasswordResetSchema,
  verifyPasswordResetCodeSchema,
  confirmPasswordResetSchema,
} from "../validators/user.validator.js";

const router = express.Router();
router.use(mongoSanitize());
router.use(hpp());
const {
  ME,
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
  GET_USERS_PENDING_POST,
  GET_USERS_WITH_STATUS,
  VALIDATE_USER_EMAIL,
  REFRESH_TOKEN,
  SITEMAP_ELIGIBLE,
  ADMIN_DETAIL,
  ADMIN_ACTION,
  PW_RESET_REQUEST,
  PW_RESET_VERIFY,
  PW_RESET_CONFIRM,
} = USER_PATH;

router.get(ME, protectRoute, asyncHandler(getMe));
router.get(
  USERS_FOLLOW,
  validate(getUsersFollowQuerySchema),
  asyncHandler(getUsersFollow),
);
router.get(
  USERS_TO_FOLLOW,
  validate(getUserToFollowsQuerySchema),
  asyncHandler(getUserToFollows),
);
router.get(
  USERS_TO_TAG,
  protectRoute,
  validate(getUsersToTagQuerySchema),
  asyncHandler(getUsersToTag),
);
router.get(
  GET_USERS_WITH_STATUS,
  protectRoute,
  requireRole(Constants.USER_ROLE.ADMIN),
  validate(getUsersWithStatusQuerySchema),
  asyncHandler(getUsersWithStatus),
);
router.get(
  ADMIN_DETAIL,
  protectRoute,
  requireRole(Constants.USER_ROLE.ADMIN),
  validate(getUserAdminDetailSchema),
  asyncHandler(getUserAdminDetail),
);
router.get(
  SITEMAP_ELIGIBLE,
  sitemapAuthGate,
  validate(getSitemapEligibleUsersQuerySchema),
  asyncHandler(getSitemapEligibleUsers),
);
router.get(
  PROFILE,
  validate(getUserProfileSchema),
  asyncHandler(getUserProfile),
);
router.post(
  GET_USERS_PENDING_POST,
  express.json({ limit: "100kb" }),
  mongoSanitize(),
  hpp(),
  protectRoute,
  validate(getUsersPendingPostSchema),
  asyncHandler(getUsersPendingPost),
);
router.post(
  SIGN_UP,
  express.json({ limit: "100kb" }),
  mongoSanitize(),
  hpp(),
  authTierLimiter,
  validate(signupUserSchema),
  asyncHandler(signupUser),
);
router.post(
  LOGIN,
  express.json({ limit: "100kb" }),
  mongoSanitize(),
  hpp(),
  authTierLimiter,
  validate(loginUserSchema),
  asyncHandler(loginUser),
);
router.post(LOGOUT, asyncHandler(logoutUser));
router.post(REFRESH_TOKEN, asyncHandler(refreshTokenHandler));
router.put(
  FOLLOW,
  express.json({ limit: "100kb" }),
  mongoSanitize(),
  hpp(),
  protectRoute,
  validate(followUserSchema),
  asyncHandler(followUser),
);
router.put(
  UPDATE,
  express.json({ limit: "50mb" }),
  mongoSanitize(),
  hpp(),
  protectRoute,
  requireSelfOrRole(Constants.USER_ROLE.ADMIN),
  validate(updateUserSchema),
  asyncHandler(updateUser),
);
router.put(
  ADMIN_ACTION,
  express.json({ limit: "100kb" }),
  mongoSanitize(),
  hpp(),
  protectRoute,
  requireRole(Constants.USER_ROLE.ADMIN),
  validate(adminUpdateUserSchema),
  asyncHandler(adminUpdateUser),
);
router.put(
  CHANGE_PW,
  express.json({ limit: "100kb" }),
  mongoSanitize(),
  hpp(),
  protectRoute,
  requireSelfOrRole(Constants.USER_ROLE.ADMIN),
  validate(changePasswordSchema),
  asyncHandler(changePassword),
);
router.post(
  PW_RESET_REQUEST,
  express.json({ limit: "100kb" }),
  mongoSanitize(),
  hpp(),
  authTierLimiter,
  validate(requestPasswordResetSchema),
  asyncHandler(requestPasswordReset),
);
router.post(
  PW_RESET_VERIFY,
  express.json({ limit: "100kb" }),
  mongoSanitize(),
  hpp(),
  authTierLimiter,
  validate(verifyPasswordResetCodeSchema),
  asyncHandler(verifyPasswordResetCode),
);
router.post(
  PW_RESET_CONFIRM,
  express.json({ limit: "100kb" }),
  mongoSanitize(),
  hpp(),
  authTierLimiter,
  validate(confirmPasswordResetSchema),
  asyncHandler(confirmPasswordReset),
);
router.post(CRAWL_USER, authTierLimiter, asyncHandler(handleCrawlFakeUsers));
router.post(
  VALIDATE_USER_EMAIL,
  express.json({ limit: "100kb" }),
  mongoSanitize(),
  hpp(),
  validate(validateEmailByCodeSchema),
  asyncHandler(validateEmailByCode),
);

export default router;
