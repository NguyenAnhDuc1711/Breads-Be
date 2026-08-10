// Schema cho router `util` (FR-8, task 015).
//
// `uploadSchema` PHẢI được mount SAU `upload.array("files")` trong `util.route.ts` — multer parse
// xong `multipart/form-data` mới có `req.body.filesName`/`req.query.userId` để validate. Mount
// trước sẽ 400 mọi upload hợp lệ (xem ARCH-2, `plan-review.md`).
import { z } from "zod";
import { objectIdSchema } from "./common.ts";

export const uploadSchema = {
  query: z.object({
    userId: objectIdSchema,
  }),
  body: z.object({
    filesName: z.string().min(1),
  }),
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
