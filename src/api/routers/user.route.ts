import express from "express";
import mongoSanitize from "express-mongo-sanitize";
import hpp from "hpp";
import {
  changePassword,
  checkValidUser,
  followUser,
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
  getSitemapEligibleUsers,
  validateEmailByCode,
  refreshTokenHandler,
  getUserAdminDetail,
  adminUpdateUser,
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
  checkValidUserSchema,
  getUserIdFromEmailSchema,
  getSitemapEligibleUsersQuerySchema,
  getUserAdminDetailSchema,
  adminUpdateUserSchema,
} from "../validators/user.validator.js";

// FR-2 (Task 011): router DUY NHẤT lẫn 2 nhóm payload trong cùng 1 file — nhóm auth/text nhỏ
// (100kb) và route avatar base64 (50mb). Vì vậy CỐ Ý không mount body-parser ở cấp router như
// 7 router kia (Task 010): mount per-route để avatar không kéo cả nhóm auth lên 50mb, và
// nhóm auth không hạ avatar xuống 100kb. 9/18 route đọc `req.body` đều PHẢI có `express.json`
// đứng đầu chain; 9 route còn lại (GET listing + LOGOUT + CRAWL_USER) không đọc body -> không mount.
const router = express.Router();
// FR-5 (task 013): mongoSanitize/hpp KHÔNG có hành vi parse-once như body-parser (khác express.json
// ở Task 011) -> an toàn mount router.use() cho CẢ file. NHƯNG router.use() ở đây chạy TRƯỚC mọi
// express.json per-route (đứng trên cùng file, đăng ký trước) -> tại thời điểm này req.body CHƯA
// được parse (POST/PUT), nên lượt sanitize này CHỈ có tác dụng thật với req.query/req.params (9 route
// GET + phần query của các route khác), KHÔNG sanitize được req.body. Vì vậy 9 route có `.body` bên
// dưới đều tự thêm mongoSanitize()/hpp() NGAY SAU express.json của route đó (mới sanitize được body).
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
  CHECK_VALID_USER,
  GET_USER_ID_FROM_EMAIL,
  GET_USERS_PENDING_POST,
  GET_USERS_WITH_STATUS,
  VALIDATE_USER_EMAIL,
  REFRESH_TOKEN,
  SITEMAP_ELIGIBLE,
  ADMIN_DETAIL,
  ADMIN_ACTION,
} = USER_PATH;

// FR-2 (Task 010, D-1): GET literal 1-segment paths (/me, /follow-list, /with-status)
// PHẢI đăng ký TRƯỚC PROFILE ("/:userId") — nếu không, "/:userId" sẽ nuốt các path literal đó
// (Express match theo thứ tự đăng ký, cùng số segment). PROFILE đứng cuối nhóm GET một cách
// CỐ Ý, không phải ngẫu nhiên.
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
// 2-segment path -> không cần quan tâm thứ tự so với PROFILE ("/:userId", 1-segment) bên dưới.
router.get(
  ADMIN_DETAIL,
  protectRoute,
  requireRole(Constants.USER_ROLE.ADMIN),
  validate(getUserAdminDetailSchema),
  asyncHandler(getUserAdminDetail),
);
// Task 003 (epic seo-sitemap-schema, FR-2): route literal 1-segment -> đăng ký TRƯỚC `PROFILE`
// (đăng ký ở dưới) để không bị nuốt, đúng convention đã ghi ở comment trên.
//
// KHÔNG có rate limiter (sibling của `/posts/sitemap-eligible` task 002 — xem lý do đầy đủ ở
// comment route đó trong `post.route.ts`: mọi ngưỡng theo-phút đều gây lỗi thật khi Next.js's
// static export gọi `getChunk()` đồng thời cho nhiều chunk lúc build; `sitemapAuthGate` là biên
// bảo mật thật duy nhất cần thiết ở đây).
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
  // Task 009 (auth-gap fix): route trước đây KHÔNG có `protectRoute` — danh tính đọc thẳng từ
  // `req.body.userId`, ai cũng giả mạo được nếu biết ID của 1 admin/moderator thật. `protectRoute`
  // đứng TRƯỚC `validate` đúng convention đầu file ("validate luôn đứng SAU optionalAuth/protectRoute").
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
// Route DUY NHẤT của router này cần limit lớn: `updateUser` nhận avatar base64 và đẩy sang
// `uploadFileFromBase64` (user.controller.ts:226). KHÔNG được gộp chung limit 100kb của nhóm auth.
// FR-2 (Task 010, D-1): UPDATE ("/:id") đăng ký SAU FOLLOW ("/follow") để không nuốt path literal
// đó — cùng lý do PROFILE đứng cuối nhóm GET ở trên.
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
// Endpoint quản trị riêng cho role/status/lý do — guard `requireRole(ADMIN)` only (không phải
// `requireSelfOrRole` như UPDATE ở trên), vì đây là hành động admin tác động lên user khác,
// không phải self-service profile edit.
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
  validate(changePasswordSchema),
  asyncHandler(changePassword),
);
// AD-3 (task 012): CRAWL_USER thiếu auth guard (PRD C-4) -> áp auth-tier nghiêm ngặt thay vì loại
// trừ khỏi rate-limit, vì đây là endpoint tốn tài nguyên (trigger seed).
router.post(CRAWL_USER, authTierLimiter, asyncHandler(handleCrawlFakeUsers));
router.post(
  CHECK_VALID_USER,
  express.json({ limit: "100kb" }),
  mongoSanitize(),
  hpp(),
  validate(checkValidUserSchema),
  asyncHandler(checkValidUser),
);
router.post(
  GET_USER_ID_FROM_EMAIL,
  express.json({ limit: "100kb" }),
  mongoSanitize(),
  hpp(),
  validate(getUserIdFromEmailSchema),
  asyncHandler(getUserIdFromEmail),
);
router.post(
  VALIDATE_USER_EMAIL,
  express.json({ limit: "100kb" }),
  mongoSanitize(),
  hpp(),
  validate(validateEmailByCodeSchema),
  asyncHandler(validateEmailByCode),
);

export default router;
