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
// Task bước 1 (epic access-control-hardening): route này TRƯỚC ĐÂY không có guard nào, và
// controller có nhánh `forgotPW` do client tự gửi bỏ qua kiểm tra mật khẩu cũ -> bất kỳ ai cũng
// đổi được mật khẩu của bất kỳ userId nào rồi đăng nhập (probe V1, xác nhận 200 + chiếm được
// tài khoản). `requireSelfOrRole(ADMIN)` dùng chung pattern với `UPDATE` ("/:id") ở trên — cả hai
// đều là hành động trên tài nguyên của chính mình, có cửa admin override.
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
// Luồng quên mật khẩu server-side (bước 2) — thay cho `POST /util/send-forgot-pw-mail` (đã xoá)
// cộng với việc đối chiếu mã ở client. Cả 3 đều thuộc auth-tier: đây là bề mặt brute-force mã 6
// ký tự và spam gửi mail, cùng nhóm rủi ro với LOGIN/SIGN_UP.
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
// AD-3 (task 012): CRAWL_USER thiếu auth guard (PRD C-4) -> áp auth-tier nghiêm ngặt thay vì loại
// trừ khỏi rate-limit, vì đây là endpoint tốn tài nguyên (trigger seed).
router.post(CRAWL_USER, authTierLimiter, asyncHandler(handleCrawlFakeUsers));
// `POST /validity-checks` và `POST /id-lookup` ĐÃ XOÁ (bước 6, access-control-hardening): 2
// endpoint công khai này là oracle dò tài khoản (email -> "có tồn tại không" / -> userId), và
// chính `/id-lookup` cung cấp userId cho bước ① của chuỗi chiếm tài khoản V1. Sau bước 2 chúng
// không còn caller nào — xem `Login.tsx`, nơi luồng quên mật khẩu giờ đi qua `password-reset/*`.
router.post(
  VALIDATE_USER_EMAIL,
  express.json({ limit: "100kb" }),
  mongoSanitize(),
  hpp(),
  validate(validateEmailByCodeSchema),
  asyncHandler(validateEmailByCode),
);

export default router;
