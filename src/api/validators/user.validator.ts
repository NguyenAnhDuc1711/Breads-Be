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
export const followUserSchema = {
  body: z.object({
    userFlId: objectIdSchema,
    userId: objectIdSchema,
  }),
};

// `updateUser` (user.controller.ts:205-255) đọc `payload = req.body` nguyên khối rồi gán từng
// key lên user doc (switch case đặc biệt cho `avatar`/`links`, `default` cho phép field bất kỳ
// đi qua) — đây là hành vi mass-assignment có sẵn, KHÔNG thuộc scope epic này để sửa. Khai báo
// rõ field thuộc `user.model.ts` hay dùng để update self-profile (đều optional — partial
// update), và dùng `.passthrough()` để không âm thầm strip field khác mà controller vẫn đang
// chấp nhận (rủi ro nêu ở AD-6).
export const updateUserSchema = {
  params: z.object({ id: objectIdSchema }),
  body: z
    .object({
      name: z.string().optional(),
      username: z.string().optional(),
      avatar: z.string().optional(),
      bio: z.string().optional(),
      links: z.array(z.string()).optional(),
    })
    .passthrough(),
};

// `changePassword` (user.controller.ts:257-260): mọi field optional ở tầng schema — logic điều
// kiện thật (forgotPW bypass currentPW, v.v.) vẫn ở controller, validate() chỉ đảm bảo TYPE.
export const changePasswordSchema = {
  params: z.object({ id: objectIdSchema }),
  body: z.object({
    currentPW: z.string().optional(),
    newPW: z.string().optional(),
    forgotPW: z.boolean().optional(),
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

export const getUsersWithStatusQuerySchema = {
  query: z.object({
    ...paginationQuerySchema.shape,
    userId: objectIdSchema,
    searchValue: z.string().optional(),
  }),
};

export const getUsersPendingPostSchema = {
  body: z.object({
    ...paginationQuerySchema.shape,
    userId: objectIdSchema,
    searchValue: z.string().optional(),
  }),
};

// `checkValidUser` (user.controller.ts:495-501): controller tự throw nếu CẢ HAI field đều thiếu —
// đây là business rule either-or, không phải type rule, nên cả hai field giữ `.optional()` ở tầng
// schema (chỉ đảm bảo TYPE nếu field có mặt).
export const checkValidUserSchema = {
  body: z.object({
    userId: objectIdSchema.optional(),
    userEmail: z.string().email().optional(),
  }),
};

export const getUserIdFromEmailSchema = {
  body: z.object({
    userEmail: z.string().email(),
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
