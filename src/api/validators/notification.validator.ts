// Schema cho router `notification` (FR-7, task 014).
//
// Router chỉ có 1 route. Lưu ý: route là `POST`, nên `page`/`limit` tới từ JSON body — dùng
// `z.number()`, KHÔNG `z.coerce.number()` (AD-5): body đã là số thật, coerce ở đây sẽ âm thầm
// chấp nhận cả string `"2"` mà client hiện tại không bao giờ gửi.
//
// `page`/`limit` bắt buộc (không optional): controller tính `skip = (page - 1) * limit` không có
// default (`notification.controller.ts:7-11`) — thiếu field sẽ thành `NaN` và `$skip: NaN` làm
// Mongo ném lỗi 500. Schema đẩy lỗi đó về 400 sớm hơn 1 tầng.
import { z } from "zod";
import { objectIdSchema } from "./common.ts";

export const getNotificationsSchema = {
  body: z.object({
    userId: objectIdSchema,
    page: z.number().int().min(1),
    limit: z.number().int().min(1),
  }),
};
