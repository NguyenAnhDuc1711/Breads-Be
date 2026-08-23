import express from "express";
import mongoSanitize from "express-mongo-sanitize";
import hpp from "hpp";
import { POST_PATH } from "../../Breads-Shared/APIConfig.js";
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
  LIKE_TOGGLE,
  TICK_SURVEY,
  CRAWL_POST,
  UPDATE_POST_STATUS,
  UPDATE_POST_VISIBILITY,
  SITEMAP_ELIGIBLE,
} = POST_PATH;

// Middleware `validate` luôn đứng SAU optionalAuth/protectRoute (auth gắn `req.viewerId`/`req.user`,
// không đọc payload) và TRƯỚC controller. `CRAWL_POST` cố ý không có schema: tool seed/dev, không
// nhận payload từ client.
// Task 011 (D-1): thứ tự đăng ký trong mỗi nhóm method có ý nghĩa — route literal 1 segment
// (`/crawl`) phải đứng TRƯỚC mọi route dynamic 1 segment cùng method, nếu không sẽ bị "nuốt"
// (cảnh báo shadow-routing từ task 010). Hiện không method nào có `/:id` trần ngoài PUT/DELETE,
// nên chỉ cần giữ nguyên trật tự dưới đây khi thêm route mới.
router.get(
  GET_ALL,
  optionalAuth,
  validate(getPostsQuerySchema),
  asyncHandler(getPosts),
);
// Task 002 (epic seo-sitemap-schema, AD-2): route literal 1-segment -> đăng ký TRƯỚC `/:id`
// (đăng ký ở dưới) để không bị nuốt, đúng convention đã ghi ở comment trên. Gate 2 lớp:
// `sitemapAuthGate` (shared-secret) trước, `authTierLimiter` (rate-limit) sau — giống hệt cách
// `CRAWL_POST` áp `authTierLimiter` một mình, chỉ thêm 1 lớp auth vì endpoint này không có JWT.
router.get(
  SITEMAP_ELIGIBLE,
  sitemapAuthGate,
  authTierLimiter,
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
// Task 011 (FR-10): `createPost` giờ `throw new {XxxError}` thay vì `res.json({error})`. Express 4
// KHÔNG tự bắt rejection của async handler -> BẮT BUỘC bọc `asyncHandler`, nếu không nhánh chặn
// repost (task 090) sẽ TREO request thay vì trả 400. Trước đây đây là route duy nhất không bọc.
router.post(CREATE, validate(createPostSchema), asyncHandler(createPost));
router.delete("/:id", validate(deletePostSchema), asyncHandler(deletePost));
router.put(UPDATE, validate(updatePostSchema), asyncHandler(updatePost));
router.post(
  LIKE_TOGGLE,
  protectRoute,
  validate(likeUnlikePostSchema),
  asyncHandler(likeUnlikePost),
);
// AD-3 (task 012): CRAWL_POST thiếu auth guard (PRD C-4) -> áp auth-tier nghiêm ngặt thay vì loại
// trừ khỏi rate-limit, vì đây là endpoint tốn tài nguyên (trigger crawl). Đăng ký TRƯỚC các POST
// dynamic để `/crawl` không bị hiểu nhầm thành `:id`.
router.post(CRAWL_POST, authTierLimiter, asyncHandler(crawlPosts));
router.post(
  TICK_SURVEY,
  validate(tickPostSurveySchema),
  asyncHandler(tickPostSurvey),
);
router.patch(
  UPDATE_POST_STATUS,
  validate(updatePostStatusSchema),
  asyncHandler(updatePostStatus),
);
router.patch(
  UPDATE_POST_VISIBILITY,
  validate(updatePostVisibilitySchema),
  asyncHandler(updatePostVisibility),
);

export default router;
