// Schema cho router `report` (FR-7, task 014; redesign RESTful task 014).
//
// 4 route: `getReports` đọc `req.query` (`report.controller.ts`) nên phải `z.coerce.number()` cho
// `page`/`limit` (query string luôn là string); `sendReport` đọc `req.body`; `responseReport`/
// `rejectReport` (PATCH /:id/response|reject) đọc `reportId` từ `req.params.id`, phần còn lại từ
// `req.body` (AD-5: body không coerce).
import { z } from "zod";
import { objectIdSchema } from "./common.ts";

// Route duy nhất trong file này dùng query. `searchValue`/`page`/`limit` optional — controller
// chuyển thẳng xuống pipeline có nhánh xử lý khi vắng mặt, không đặt default ở schema để giữ
// nguyên hành vi (NFR-4).
// Bước 10: `userId` ĐÃ BỎ — quyền xét trên `req.user.role` (protectRoute đã nạp), không phải trên userId client gửi.
export const getReportsSchema = {
  query: z.object({
    searchValue: z.string().optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).optional(),
  }),
};

// `media` là mảng file base64 (`{url, ...}`) được `uploadFileFromBase64` xử lý từng phần tử;
// giữ `z.any()` cho phần tử để không siết shape mà tầng upload hiện chưa ràng buộc (NFR-4).
// Bước 9: `userId` (người báo cáo) ĐÃ BỎ — lấy từ `req.user._id`, không nhận từ client.
export const sendReportSchema = {
  body: z.object({
    content: z.string().optional(),
    media: z.array(z.any()).optional(),
  }),
};

// `from`/`to` là ĐỊA CHỈ EMAIL THẬT, đi thẳng vào `sendMailService` (`report.controller.ts:144`),
// không phải text hiển thị cho người dùng. Validate `.email()` ở đây chặn payload dị dạng TRƯỚC
// khi chạm tới lệnh gửi mail thật — controller chỉ check truthy nên "abc" vẫn lọt qua được.
// Task 014 (D-1): reportId chuyển từ body vào path (PATCH /:id/response).
// Bước 10: `userId` ĐÃ BỎ — quyền xét trên `req.user.role` (protectRoute đã nạp), không phải trên userId client gửi.
// #1 (rà soát bảo mật): `from`/`to` ĐÃ BỎ — người gửi do `sendMailService` quyết, người nhận
// suy ra từ report đang trả lời. Nhận 2 field này từ client là biến endpoint thành mail relay.
export const responseReportSchema = {
  params: z.object({
    id: objectIdSchema,
  }),
  body: z.object({
    subject: z.string().min(1),
    html: z.string().optional(),
  }),
};

// Task 014 (D-1): reportId chuyển từ body vào path (PATCH /:id/reject).
// Bước 10: `userId` ĐÃ BỎ — quyền xét trên `req.user.role` (protectRoute đã nạp), không phải trên userId client gửi.
export const rejectReportSchema = {
  params: z.object({
    id: objectIdSchema,
  }),
  body: z.object({
  }),
};

// Breads-Admin Users module: toàn bộ lịch sử report 1 user ĐÃ NỘP (mọi status) — guard
// `requireRole(ADMIN)` ở route, không cần userId caller trong query như `getReportsSchema`.
export const getReportsByUserSchema = {
  params: z.object({
    id: objectIdSchema,
  }),
};
