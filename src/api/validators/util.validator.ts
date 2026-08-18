// Schema cho router `util` (FR-8, task 015).
//
// `uploadSchema` PHẢI được mount SAU `upload.array("files")` trong `util.route.ts` — multer parse
// xong `multipart/form-data` mới có `req.body.filesName`/`req.query.userId` để validate. Mount
// trước sẽ 400 mọi upload hợp lệ (xem ARCH-2, `plan-review.md`).
import { z } from "zod";
import { objectIdSchema } from "./common.ts";

// `entityType` + context quyết định `public_id` (`generatePublicId`, xem `util.route.ts`), theo
// đúng convention đã dùng cho `media` (`mediaSignSchema`). `recipientId` bắt buộc cho message
// (không có nó thì `generatePublicId` throw); vô nghĩa cho post. Danh tính người upload
// (`senderId`/`authorId`) LUÔN lấy từ `req.user`, không nhận từ client.
export const uploadSchema = {
  query: z.object({
    userId: objectIdSchema,
  }),
  body: z.discriminatedUnion("entityType", [
    z.object({
      entityType: z.literal("message"),
      recipientId: objectIdSchema,
      filesName: z.string().min(1),
    }),
    z.object({
      entityType: z.literal("post"),
      filesName: z.string().min(1),
    }),
  ]),
};

export const sendForgotPWMailSchema = {
  body: z.object({
    from: z.string().email(),
    to: z.string().email(),
    subject: z.string().min(1),
    code: z.string().min(1),
    url: z.string().min(1),
  }),
};
