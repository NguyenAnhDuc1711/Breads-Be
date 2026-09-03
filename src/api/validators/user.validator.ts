// Schema cho router `user` — nhóm auth/profile (Task 010, 9/18 route).
//
// LƯU Ý: file này còn được Task 011 ghi thêm export cho 9 route còn lại (listing/admin) — xem
// Interface Contract trong `010.md`. Không xoá/định dạng lại export có sẵn khi merge.
//
// Field lấy trực tiếp từ `user.controller.ts` (không đoán/"dọn" tên field) — xem bảng trong
// `010.md` §Description.
import { z } from "zod";
import { objectIdSchema, paginationQuerySchema, rankedCursorSchema } from "./common.ts";

export const getUserProfileSchema = {
  params: z.object({ userId: objectIdSchema }),
};

export const signupUserSchema = {
  body: z.object({
    name: z.string().min(1),
    email: z.string().email(),
    username: z.string().min(1),
    password: z.string().min(1),
  }),
};

export const loginUserSchema = {
  body: z.object({
    email: z.string().email(),
    password: z.string().min(1),
  }),
};

// Field thật là `userFlId` + `userId` (user.controller.ts:189) — KHÔNG đổi tên.
// Bước 4: `userId` ĐÃ BỎ — người follow luôn là `req.user._id`, không phải giá trị client gửi kèm.
export const followUserSchema = {
  body: z.object({
    userFlId: objectIdSchema,
  }),
};

// `updateUser` (user.controller.ts:205-255) đọc `payload = req.body` nguyên khối rồi gán từng
// key lên user doc (switch case đặc biệt cho `avatar`/`links`, `default` cho phép field bất kỳ
// đi qua). Route này guard bằng `requireSelfOrRole(ADMIN)` — tức 1 user thường sửa CHÍNH mình
// cũng lọt qua guard đó, nên trước đây `.passthrough()` cho phép field bất kỳ (kể cả `role`,
// `status`) đi xuyên qua validate rồi bị controller gán thẳng vào doc -> tự nâng quyền. Bỏ
// `.passthrough()`: `z.object()` mặc định loại bỏ key không khai báo, nên `role`/`status` (và
// bất kỳ field lạ nào khác) bị strip trước khi tới controller. Field `role`/`status` giờ CHỈ
// đổi được qua `adminUpdateUserSchema` (guard `requireRole(ADMIN)` riêng, không phải self).
export const updateUserSchema = {
  params: z.object({ id: objectIdSchema }),
  body: z.object({
    name: z.string().optional(),
    username: z.string().optional(),
    avatar: z.string().optional(),
    bio: z.string().optional(),
    links: z.array(z.string()).optional(),
  }),
};

export const getUserAdminDetailSchema = {
  params: z.object({ id: objectIdSchema }),
};

export const adminUpdateUserSchema = {
  params: z.object({ id: objectIdSchema }),
  body: z.object({
    role: z.number().optional(),
    status: z.number().optional(),
    reason: z.string().optional(),
  }),
};

// Đổi mật khẩu KHI ĐÃ ĐĂNG NHẬP. `forgotPW` đã bị XOÁ khỏi schema (epic access-control-hardening,
// bước 1): cờ này do client tự gửi và bỏ qua toàn bộ kiểm tra mật khẩu cũ ở controller — kết hợp
// với route thiếu `protectRoute` là đường chiếm tài khoản không cần đăng nhập (probe V1).
// `z.object()` strip key không khai báo nên client cũ còn gửi `forgotPW` vẫn đi lọt tầng validate,
// nhưng giá trị bị vứt bỏ trước khi tới controller — không còn ảnh hưởng gì.
//
// `currentPW`/`newPW` chuyển từ optional -> BẮT BUỘC: `bcrypt.compare(undefined, hash)` ném
// "Illegal arguments" và rơi vào nhánh 500 generic thay vì 400 (phát hiện khi chạy probe bước 0).
// Chặn ở schema đúng hơn là vá bằng guard trong controller.
export const changePasswordSchema = {
  params: z.object({ id: objectIdSchema }),
  body: z.object({
    currentPW: z.string().min(1),
    newPW: z.string().min(6),
  }),
};

// ---- Luồng quên mật khẩu server-side (bước 2) ----

// Không có `userId`: bước này CỐ Ý chỉ nhận email và LUÔN trả 200 (xem controller) để không biến
// endpoint thành công cụ dò tài khoản tồn tại — cùng lớp vấn đề với probe V8.
export const requestPasswordResetSchema = {
  body: z.object({ email: z.string().email() }),
};

// `genRandomCode()` (Breads-Shared/util) sinh đúng 6 ký tự chữ/số -> ràng buộc độ dài ở đây để
// request rác bị loại trước khi chạm Redis.
const resetCodeSchema = z.string().length(6);

export const verifyPasswordResetCodeSchema = {
  body: z.object({ email: z.string().email(), code: resetCodeSchema }),
};

export const confirmPasswordResetSchema = {
  body: z.object({
    userId: objectIdSchema,
    code: resetCodeSchema,
    newPW: z.string().min(6),
  }),
};

export const validateEmailByCodeSchema = {
  body: z.object({
    email: z.string().email(),
    code: z.string().min(1),
  }),
};

// ---- Task 011: 9 route listing/admin (xem `011.md` §Description) ----

// `getUsersFollow` (user.controller.ts:409-418): `type` phải là "followed"|"following" (controller
// tự throw BadRequestError nếu khác, dòng 414-415). `limit` là route DUY NHẤT trong repo có cap
// `.max(50)` sẵn (dòng 418) — cap LOCAL ở đây, KHÔNG đưa vào `paginationQuerySchema` dùng chung
// (xem note trong `common.ts`, AD-3).
export const getUsersFollowQuerySchema = {
  query: z.object({
    ...paginationQuerySchema.shape,
    limit: paginationQuerySchema.shape.limit.unwrap().max(50).optional(),
    userId: objectIdSchema,
    type: z.enum(["followed", "following"]),
  }),
};

// `getUserToFollows` (user.controller.ts:326-339): khi `isTest` truthy, controller bỏ qua hoàn
// toàn check userId/page/limit và trả sớm — vì vậy các field này giữ `.optional()` ở tầng schema,
// điều kiện bắt buộc thật vẫn nằm ở controller. `isTest` là boolean thật gửi qua query string —
// KHÔNG dùng `z.coerce.boolean()` (footgun: `Boolean("false") === true`), dùng
// `z.enum(["true","false"]).optional().transform(...)` per AD-5.
export const getUserToFollowsQuerySchema = {
  query: z.object({
    ...paginationQuerySchema.shape,
    userId: objectIdSchema.optional(),
    searchValue: z.string().optional(),
    isTest: z
      .enum(["true", "false"])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === "true")),
  }),
};

export const getUsersToTagQuerySchema = {
  query: z.object({
    ...paginationQuerySchema.shape,
    userId: objectIdSchema,
    searchValue: z.string().optional(),
  }),
};

// Users module (Breads-Admin): role/status/dateFrom/dateTo là filter tuỳ chọn cho danh sách —
// role/status exact match, dateFrom/dateTo là range trên `createdAt` (đủ 1 trong 2 đầu vẫn hợp lệ,
// business rule range hợp lý để controller tự xử lý, schema chỉ đảm bảo TYPE là Date).
// Bước 10: `userId` ĐÃ BỎ — quyền xét trên `req.user.role` (protectRoute đã nạp), không phải trên userId client gửi.
export const getUsersWithStatusQuerySchema = {
  query: z.object({
    ...paginationQuerySchema.shape,
    searchValue: z.string().optional(),
    role: z.coerce.number().optional(),
    status: z.coerce.number().optional(),
    dateFrom: z.coerce.date().optional(),
    dateTo: z.coerce.date().optional(),
  }),
};

// Task 009 (auth-gap fix): `userId` bỏ khỏi schema — danh tính giờ lấy từ `req.user._id`
// (`protectRoute`), không còn qua `req.body` (xem `user.route.ts`/`user.controller.ts`).
export const getUsersPendingPostSchema = {
  body: z.object({
    ...paginationQuerySchema.shape,
    searchValue: z.string().optional(),
  }),
};


// Task 003 (epic seo-sitemap-schema, FR-2): query cho `GET /users/sitemap-eligible`. Mirror ĐÚNG
// `getSitemapEligiblePostsQuerySchema` (post.validator.ts, task 002) — cursor là `_id` (ổn định qua
// nhiều trang), `limit` default 1000, cap cứng 1000 (khác `paginationQuerySchema` dùng chung không
// cap — endpoint này gọi server-to-server bởi sitemap generator, không phải client app, nên cap tại
// đây không ảnh hưởng NFR-4 vốn nói về router client-facing).
export const getSitemapEligibleUsersQuerySchema = {
  // Cursor đổi từ `objectIdSchema` sang `rankedCursorSchema` ("followersCount:id") — sort giờ là
  // (followersCount giảm dần, _id giảm dần), không còn thuần `_id` (top-N ưu tiên).
  query: z.object({
    cursor: rankedCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(1000).optional().default(1000),
  }),
};

// `checkValidUserSchema` / `getUserIdFromEmailSchema` ĐÃ XOÁ cùng endpoint của chúng (bước 6).
