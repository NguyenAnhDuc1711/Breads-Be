// Schema cho router `notification` (FR-7, task 014).
//
// Router có 2 route (`getNotificationsSchema` cho `POST /get`, `readNotificationsSchema` cho
// `PATCH /read` — task 010 epic notification-fixes). Lưu ý: route `/get` là `POST`, nên `page`/`limit`
// tới từ JSON body — dùng
// `z.number()`, KHÔNG `z.coerce.number()` (AD-5): body đã là số thật, coerce ở đây sẽ âm thầm
// chấp nhận cả string `"2"` mà client hiện tại không bao giờ gửi.
//
// `page`/`limit` bắt buộc (không optional): controller tính `skip = (page - 1) * limit` không có
// default (`notification.controller.ts:7-11`) — thiếu field sẽ thành `NaN` và `$skip: NaN` làm
// Mongo ném lỗi 500. Schema đẩy lỗi đó về 400 sớm hơn 1 tầng.
//
// FR-1 (epic notification-fixes): key định danh người nhận đã bị XOÁ khỏi body — danh tính lấy từ
// `req.user` do `protectRoute` gắn. `z.object()` mặc định strip key lạ, nên FE cũ vẫn gửi key đó
// thì request vẫn 200 và key bị bỏ đi trước khi tới controller (NFR-1, backward compat).
//
// FR-6: `action` optional lọc theo loại thông báo — `z.enum` trên `Constants.NOTIFICATION_ACTION`
// chứ KHÔNG `z.string()`: giá trị này đi thẳng vào `$match`, chuỗi tự do là bề mặt injection.
import { z } from "zod";
import { Constants } from "../../Breads-Shared/Constants/index.js";
import { objectIdSchema } from "./common.ts";

export const getNotificationsSchema = {
  body: z.object({
    page: z.number().int().min(1),
    limit: z.number().int().min(1),
    action: z.enum(Constants.NOTIFICATION_ACTION).optional(),
  }),
};

// FR-3 (task 010): XOR notificationId / markAll — đúng 1 trong 2, không cả hai, không rỗng.
// `markAll` là `z.literal(true)` (không `z.boolean()`): `markAll: false` không phải một ý định hợp lệ.
export const readNotificationsSchema = {
  body: z
    .object({
      notificationId: objectIdSchema.optional(),
      markAll: z.literal(true).optional(),
    })
    .refine(
      (b) => Boolean(b.notificationId) !== Boolean(b.markAll),
      "đúng 1 trong 2: notificationId HOẶC markAll"
    ),
};
