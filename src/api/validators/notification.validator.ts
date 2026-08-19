// Schema cho router `notification` (FR-7, task 014; redesign RESTful task 013).
//
// Router có 2 route (`getNotificationsSchema` cho `GET /`, `readNotificationsSchema` cho
// `PATCH /read`). Route `/` là `GET` (đổi từ `POST /get` ở task 013) nên `page`/`limit`/`action`
// tới từ `req.query`, dùng `z.coerce.number()` (query string luôn là string, khác body).
//
// `page`/`limit` bắt buộc (không optional): controller tính `skip = (page - 1) * limit` không có
// default (`notification.controller.ts`) — thiếu field sẽ thành `NaN` và `$skip: NaN` làm
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

// Task 013 (D-1): route đổi POST /get -> GET /, page/limit/action chuyển từ body sang query.
// z.coerce.number() BẮT BUỘC ở đây (khác body ở trên) vì query string luôn là string (theo đúng
// pattern AD-5 đã dùng ở getReportsSchema). page/limit vẫn bắt buộc (không optional) — controller
// (`notification.controller.ts`) không có default cho `skip = (page - 1) * limit`.
export const getNotificationsSchema = {
  query: z.object({
    page: z.coerce.number().int().min(1),
    limit: z.coerce.number().int().min(1),
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
