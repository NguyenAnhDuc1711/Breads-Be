import express from "express";
import mongoSanitize from "express-mongo-sanitize";
import hpp from "hpp";
import { POST_PATH } from "../../Breads-Shared/APIConfig.js";
import { Constants } from "../../Breads-Shared/Constants/index.js";
import asyncHandler from "../../helpers/asyncHandler.js";
import {
  createPost,
  deletePost,
  getPost,
  getPostActivities,
  getPostReplies,
  getPosts,
  getSitemapEligiblePosts,
  likeUnlikePost,
  tickPostSurvey,
  updatePost,
  updatePostStatus,
  updatePostVisibility,
} from "../controllers/post.controller.js";
import { crawlPosts } from "../crawl.js";
import optionalAuth from "../middlewares/optionalAuth.js";
import protectRoute from "../middlewares/protectRoute.js";
import { requireRole } from "../middlewares/requireRole.js";
import { authTierLimiter } from "../middlewares/rateLimiter.js";
import sitemapAuthGate from "../middlewares/sitemapAuthGate.js";
import { validate } from "../middlewares/validate.js";
import {
  createPostSchema,
  deletePostSchema,
  getPostActivitiesSchema,
  getPostRepliesSchema,
  getPostSchema,
  getPostsQuerySchema,
  getSitemapEligiblePostsQuerySchema,
  likeUnlikePostSchema,
  tickPostSurveySchema,
  updatePostSchema,
  updatePostStatusSchema,
  updatePostVisibilitySchema,
} from "../validators/post.validator.js";

const router = express.Router();
router.use(express.json({ limit: "50mb" }));
router.use(mongoSanitize());
router.use(hpp());
const {
  GET_ALL,
  CREATE,
  UPDATE,
  LIKE_TOGGLE,
  TICK_SURVEY,
  CRAWL_POST,
  UPDATE_POST_STATUS,
  UPDATE_POST_VISIBILITY,
  SITEMAP_ELIGIBLE,
} = POST_PATH;

router.get(
  GET_ALL,
  optionalAuth,
  validate(getPostsQuerySchema),
  asyncHandler(getPosts),
);
router.get(
  SITEMAP_ELIGIBLE,
  sitemapAuthGate,
  validate(getSitemapEligiblePostsQuerySchema),
  asyncHandler(getSitemapEligiblePosts),
);
router.get(
  "/:id/activities",
  optionalAuth,
  validate(getPostActivitiesSchema),
  asyncHandler(getPostActivities),
);
router.get(
  "/:id/replies",
  optionalAuth,
  validate(getPostRepliesSchema),
  asyncHandler(getPostReplies),
);
router.get(
  "/:id",
  optionalAuth,
  validate(getPostSchema),
  asyncHandler(getPost),
);
router.post(
  CREATE,
  protectRoute,
  validate(createPostSchema),
  asyncHandler(createPost),
);
router.delete(
  "/:id",
  protectRoute,
  validate(deletePostSchema),
  asyncHandler(deletePost),
);
router.put(
  UPDATE,
  protectRoute,
  validate(updatePostSchema),
  asyncHandler(updatePost),
);
router.post(
  LIKE_TOGGLE,
  protectRoute,
  validate(likeUnlikePostSchema),
  asyncHandler(likeUnlikePost),
);
router.post(CRAWL_POST, authTierLimiter, asyncHandler(crawlPosts));
router.post(
  TICK_SURVEY,
  protectRoute,
  validate(tickPostSurveySchema),
  asyncHandler(tickPostSurvey),
);
router.patch(
  UPDATE_POST_STATUS,
  protectRoute,
  requireRole(Constants.USER_ROLE.ADMIN, Constants.USER_ROLE.MODERATOR),
  validate(updatePostStatusSchema),
  asyncHandler(updatePostStatus),
);
router.patch(
  UPDATE_POST_VISIBILITY,
  protectRoute,
  validate(updatePostVisibilitySchema),
  asyncHandler(updatePostVisibility),
);

export default router;
