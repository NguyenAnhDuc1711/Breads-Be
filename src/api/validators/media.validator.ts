// Schema cho router `media` (epic presigned-media-upload, task 002 — FR-6/FR-7/NFR-4).
//
// Điểm quan trọng nhất của file này KHÔNG phải là các rule min/max, mà là những field CỐ Ý KHÔNG
// khai báo: `authorId`/`senderId`. `z.object()` mặc định LOẠI BỎ key không khai báo, nên nếu client
// gửi kèm `authorId` giả, field đó biến mất khỏi `req.body` sau `validate()` — controller không có
// cách nào vô tình đọc phải. Danh tính người ký LUÔN lấy từ `req.user` (protectRoute), xem
// `media.controller.ts`.
import { z } from "zod";
import { objectIdSchema } from "./common.ts";

// Cap batch chốt ở PRD FR-6. Export để `cloudinarySign.ts`/test tham chiếu đúng 1 nguồn.
export const MEDIA_SIGN_BATCH_MAX = 10;

// Khớp `Constants.MEDIA_TYPE` (`src/Breads-Shared/Constants/index.ts:6`). Viết literal ở đây vì
// `z.enum` cần tuple literal — giá trị phải giữ đồng bộ với Constants nếu constant đổi.
export const MEDIA_TYPE_VALUES = ["image", "gif", "video"] as const;

// 1 phần tử `items[i]` mô tả file thứ i trong batch. Chỉ cần `type` — dùng để chọn `resourceType`
// Cloudinary (FR-7). Không nhận `url`/bytes: endpoint này không bao giờ chạm tới nội dung file.
const mediaSignItemSchema = z.object({
  type: z.enum(MEDIA_TYPE_VALUES),
});

const batchFields = {
  count: z.number().int().min(1).max(MEDIA_SIGN_BATCH_MAX),
  // Optional: client không khai `items` -> toàn bộ batch coi như image (mặc định an toàn nhất).
  items: z.array(mediaSignItemSchema).min(1).max(MEDIA_SIGN_BATCH_MAX).optional(),
};

// `discriminatedUnion` thay vì 1 object + `.refine()`: `recipientId` là BẮT BUỘC cho message
// (không có nó thì `generatePublicId` throw) và VÔ NGHĨA cho post — union bắt đúng ràng buộc đó ở
// tầng schema, controller không phải check lại.
export const mediaSignSchema = {
  body: z
    .discriminatedUnion("entityType", [
      z.object({
        entityType: z.literal("message"),
        recipientId: objectIdSchema,
        ...batchFields,
      }),
      z.object({
        entityType: z.literal("post"),
        ...batchFields,
      }),
    ])
    .refine((body) => !body.items || body.items.length === body.count, {
      message: "items length must equal count",
      path: ["items"],
    }),
};
