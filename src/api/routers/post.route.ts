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
// (đăng ký ở dưới) để không bị nuốt, đúng convention đã ghi ở comment trên.
//
// KHÔNG có rate limiter trên route này (đã thử `authTierLimiter` 5/phút rồi `sitemapListLimiter`
// 300/phút, cả 2 đều gây lỗi thật khi verify sống — xem lịch sử trong `rateLimiter.ts`). Root
// cause: Next.js's static export chạy `getChunk(id)` cho NHIỀU chunk ĐỒNG THỜI lúc build, mỗi
// chunk xa (id lớn) phải đi qua nhiều trang trước đó — tổng tải cộng dồn vượt BẤT KỲ ngưỡng
// theo-phút nào bất kể đặt cao thế nào, vì toàn bộ traversal hoàn thành nhanh hơn nhiều so với cửa
// sổ 60s của limiter. Route đã được bảo vệ bằng `sitemapAuthGate` (AD-3, shared-secret,
// server-to-server only) — đây MỚI là biên bảo mật thật; rate-limit ở đây chưa từng thêm giá trị
// bảo mật thật (không ai không có secret gọi được route này), chỉ toàn gây false-positive cho
// chính client hợp lệ duy nhất của nó.
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
// Task 011 (FR-10): `createPost` giờ `throw new {XxxError}` thay vì `res.json({error})`. Express 4
// KHÔNG tự bắt rejection của async handler -> BẮT BUỘC bọc `asyncHandler`, nếu không nhánh chặn
// repost (task 090) sẽ TREO request thay vì trả 400. Trước đây đây là route duy nhất không bọc.
// Bước 3 (access-control-hardening): 4 route ghi dưới đây TRƯỚC ĐÂY không có guard nào — danh tính
// đọc thẳng từ `payload.authorId` / `payload.userId` / `req.query.userId`, tức là do client tự khai.
// Probe xác nhận cả 4 đều khai thác được KHÔNG cần đăng nhập: đăng bài mạo danh (V2a), sửa (V2b) và
// xoá (V2c) bài người khác, nhồi phiếu khảo sát (V5). `protectRoute` đứng TRƯỚC `validate` đúng
// convention đã ghi ở đầu file.
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
// AD-3 (task 012): CRAWL_POST thiếu auth guard (PRD C-4) -> áp auth-tier nghiêm ngặt thay vì loại
// trừ khỏi rate-limit, vì đây là endpoint tốn tài nguyên (trigger crawl). Đăng ký TRƯỚC các POST
// dynamic để `/crawl` không bị hiểu nhầm thành `:id`.
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
// Khác `UPDATE_POST_STATUS` ngay trên: đổi quyền riêng tư là hành động của CHỦ SỞ HỮU (admin/mod
// chỉ là cửa kiểm duyệt bổ sung), nên KHÔNG dùng `requireRole` ở route — nó sẽ khoá cửa chính.
// Phân quyền nằm trong controller: `isOwner || isModerator`, cả hai xét trên `req.user`.
router.patch(
  UPDATE_POST_VISIBILITY,
  protectRoute,
  validate(updatePostVisibilitySchema),
  asyncHandler(updatePostVisibility),
);

export default router;
