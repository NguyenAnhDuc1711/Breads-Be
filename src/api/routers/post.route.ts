import express from "express";
import mongoSanitize from "express-mongo-sanitize";
import hpp from "hpp";
import { POST_PATH } from "../../Breads-Shared/APIConfig.js";
import {
  createPost,
  deletePost,
  getPost,
  getPosts,
  likeUnlikePost,
  tickPostSurvey,
  updatePost,
  updatePostStatus,
  updatePostVisibility,
} from "../controllers/post.controller.js";
import { crawlPosts } from "../crawl.js";
import optionalAuth from "../middlewares/optionalAuth.js";
import protectRoute from "../middlewares/protectRoute.js";
import { authTierLimiter } from "../middlewares/rateLimiter.js";
import { validate } from "../middlewares/validate.js";
import Post from "../models/post.model.js";
import {
  createPostSchema,
  deletePostSchema,
  getPostSchema,
  getPostsQuerySchema,
  likeUnlikePostSchema,
  tickPostSurveySchema,
  updatePostSchema,
  updatePostStatusSchema,
  updatePostVisibilitySchema,
} from "../validators/post.validator.js";
import asyncHandler from "../../helpers/asyncHandler.js";

const router = express.Router();
// FR-2 (task 010): createPost/updatePost nhận `media`/`files` base64 -> giữ 50mb như global cũ.
router.use(express.json({ limit: "50mb" }));
// FR-5 (task 013): strip key NoSQL operator ($/.) khỏi body/query/params + giữ giá trị cuối khi
// query key lặp (HPP). Không có hành vi parse-once như body-parser -> an toàn mount router.use().
router.use(mongoSanitize());
router.use(hpp());
const {
  GET_ALL,
  CREATE,
  UPDATE,
  LIKE,
  TICK_SURVEY,
  CRAWL_POST,
  UPDATE_POST_STATUS,
  UPDATE_POST_VISIBILITY,
} = POST_PATH;

// Middleware `validate` luôn đứng SAU optionalAuth/protectRoute (auth gắn `req.viewerId`/`req.user`,
// không đọc payload) và TRƯỚC controller. `CRAWL_POST` cố ý không có schema: tool seed/dev, không
// nhận payload từ client.
router.get(GET_ALL, optionalAuth, validate(getPostsQuerySchema), asyncHandler(getPosts));
router.get("/:id", optionalAuth, validate(getPostSchema), asyncHandler(getPost));
router.post(CREATE, validate(createPostSchema), createPost);
router.delete("/:id", validate(deletePostSchema), asyncHandler(deletePost));
router.put(UPDATE, validate(updatePostSchema), asyncHandler(updatePost));
router.post(
  LIKE + ":id",
  protectRoute,
  validate(likeUnlikePostSchema),
  asyncHandler(likeUnlikePost)
);
router.put(TICK_SURVEY, validate(tickPostSurveySchema), asyncHandler(tickPostSurvey));
// AD-3 (task 012): CRAWL_POST thiếu auth guard (PRD C-4) -> áp auth-tier nghiêm ngặt thay vì loại
// trừ khỏi rate-limit, vì đây là endpoint tốn tài nguyên (trigger crawl).
router.post(CRAWL_POST, authTierLimiter, asyncHandler(crawlPosts));
router.post(
  UPDATE_POST_STATUS,
  validate(updatePostStatusSchema),
  asyncHandler(updatePostStatus)
);
router.post(
  UPDATE_POST_VISIBILITY,
  validate(updatePostVisibilitySchema),
  asyncHandler(updatePostVisibility)
);

export default router;
