// Primitive zod dùng chung cho mọi router (AD-3).
//
// `objectIdSchema` tái dùng `mongoose.isValidObjectId` — hàm thuần, sync, KHÔNG query DB — thay vì
// tự viết regex, để repo chỉ có ĐÚNG 1 định nghĩa "ObjectId hợp lệ" (tránh 2 nguồn sự thật lệch
// nhau theo thời gian). Schema theo GIÁ TRỊ, không phụ thuộc tên key: dùng lại được cho cả
// `z.object({ id: objectIdSchema })` lẫn `z.object({ userId: objectIdSchema })`.
//
// `paginationQuerySchema` CỐ Ý không có `.max()` cho `limit`: nhánh dùng nhiều nhất hiện tại
// (`services/post.ts:492-493`) không cap `limit`, nên đặt cap ở primitive DÙNG CHUNG sẽ âm thầm áp
// giới hạn MỚI lên mọi router (vi phạm NFR-4). Router nào cần cap (chỉ `user`, xem
// `user.controller.ts:417-418`) tự thêm `.max(50)` cục bộ trong file schema của router đó.
import mongoose from "mongoose";
import { z } from "zod";

export const objectIdSchema = z
  .string()
  .refine(mongoose.isValidObjectId, "invalid id");

// Cursor phức hợp "score:id" cho phân trang theo (field xếp hạng giảm dần, _id giảm dần) — dùng
// chung cho `/posts/sitemap-eligible` (engagementScore) và `/users/sitemap-eligible`
// (followersCount) sau fix "top-N ưu tiên" (epic seo-sitemap-schema). `score` là số nguyên KHÔNG
// âm (engagementScore/followersCount đều không âm theo model) ở dạng chuỗi trong query string;
// `id` phải là ObjectId hợp lệ.
export const rankedCursorSchema = z
  .string()
  .refine((v) => {
    const parts = v.split(":");
    if (parts.length !== 2) return false;
    const [score, id] = parts;
    return /^\d+$/.test(score) && mongoose.isValidObjectId(id);
  }, "invalid cursor — expected format \"score:id\"");

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).optional(),
});
