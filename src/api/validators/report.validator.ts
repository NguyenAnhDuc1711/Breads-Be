// Schema cho router `report` (FR-7, task 014).
//
// 4 route, nhưng KHÔNG đồng nhất về nguồn payload: `getReports` đọc `req.query`
// (`report.controller.ts:55`) nên phải `z.coerce.number()` cho `page`/`limit` (query string luôn
// là string); 3 route còn lại đọc `req.body` nên dùng kiểu thẳng, không coerce (AD-5).
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
export const responseReportSchema = {
  body: z.object({
    from: z.string().email(),
    to: z.string().email(),
    subject: z.string().min(1),
    html: z.string().optional(),
    userId: objectIdSchema,
    reportId: objectIdSchema,
  }),
};

export const rejectReportSchema = {
  body: z.object({
    userId: objectIdSchema,
    reportId: objectIdSchema,
  }),
};
