import express from "express";
import {
  changePassword,
  checkValidUser,
  followUser,
  getAdminAccount,
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

const router = express.Router();
const {
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

router.get(USERS_FOLLOW, asyncHandler(getUsersFollow));
router.get(ADMIN, asyncHandler(getAdminAccount));
router.get(PROFILE + ":userId", asyncHandler(getUserProfile));
router.get(USERS_TO_FOLLOW, asyncHandler(getUserToFollows));
router.get(USERS_TO_TAG, protectRoute, asyncHandler(getUsersToTag));
router.get(GET_USERS_WITH_STATUS, asyncHandler(getUsersWithStatus));
router.post(GET_USERS_PENDING_POST, asyncHandler(getUsersPendingPost));
router.post(SIGN_UP, asyncHandler(signupUser));
router.post(LOGIN, asyncHandler(loginUser));
router.post(LOGOUT, asyncHandler(logoutUser));
router.put(FOLLOW, protectRoute, asyncHandler(followUser));
router.put(UPDATE + ":id", protectRoute, asyncHandler(updateUser));
router.put(CHANGE_PW + ":id", asyncHandler(changePassword));
router.post(CRAWL_USER, asyncHandler(handleCrawlFakeUsers));
router.post(CHECK_VALID_USER, asyncHandler(checkValidUser));
router.post(GET_USER_ID_FROM_EMAIL, asyncHandler(getUserIdFromEmail));
router.post(VALIDATE_USER_EMAIL, asyncHandler(validateEmailByCode));

export default router;
