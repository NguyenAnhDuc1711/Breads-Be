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
export const getReportsSchema = {
  query: z.object({
    userId: objectIdSchema,
    searchValue: z.string().optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).optional(),
  }),
};

// `media` là mảng file base64 (`{url, ...}`) được `uploadFileFromBase64` xử lý từng phần tử;
// giữ `z.any()` cho phần tử để không siết shape mà tầng upload hiện chưa ràng buộc (NFR-4).
export const sendReportSchema = {
  body: z.object({
    userId: objectIdSchema,
    content: z.string().optional(),
    media: z.array(z.any()).optional(),
  }),
};

// `from`/`to` là ĐỊA CHỈ EMAIL THẬT, đi thẳng vào `sendMailService` (`report.controller.ts:144`),
// không phải text hiển thị cho người dùng. Validate `.email()` ở đây chặn payload dị dạng TRƯỚC
// khi chạm tới lệnh gửi mail thật — controller chỉ check truthy nên "abc" vẫn lọt qua được.
// Task 014 (D-1): reportId chuyển từ body vào path (PATCH /:id/response).
export const responseReportSchema = {
  params: z.object({
    id: objectIdSchema,
  }),
  body: z.object({
    from: z.string().email(),
    to: z.string().email(),
    subject: z.string().min(1),
    html: z.string().optional(),
    userId: objectIdSchema,
  }),
};

// Task 014 (D-1): reportId chuyển từ body vào path (PATCH /:id/reject).
export const rejectReportSchema = {
  params: z.object({
    id: objectIdSchema,
  }),
  body: z.object({
    userId: objectIdSchema,
  }),
};
