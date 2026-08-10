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
  validate(getUsersPendingPostSchema),
  asyncHandler(getUsersPendingPost)
);
router.post(SIGN_UP, validate(signupUserSchema), asyncHandler(signupUser));
router.post(LOGIN, validate(loginUserSchema), asyncHandler(loginUser));
router.post(LOGOUT, asyncHandler(logoutUser));
router.put(
  FOLLOW,
  protectRoute,
  validate(followUserSchema),
  asyncHandler(followUser)
);
router.put(
  UPDATE + ":id",
  protectRoute,
  validate(updateUserSchema),
  asyncHandler(updateUser)
);
router.put(
  CHANGE_PW + ":id",
  validate(changePasswordSchema),
  asyncHandler(changePassword)
);
router.post(CRAWL_USER, asyncHandler(handleCrawlFakeUsers));
router.post(
  CHECK_VALID_USER,
  validate(checkValidUserSchema),
  asyncHandler(checkValidUser)
);
router.post(
  GET_USER_ID_FROM_EMAIL,
  validate(getUserIdFromEmailSchema),
  asyncHandler(getUserIdFromEmail)
);
router.post(
  VALIDATE_USER_EMAIL,
  validate(validateEmailByCodeSchema),
  asyncHandler(validateEmailByCode)
);

export default router;
