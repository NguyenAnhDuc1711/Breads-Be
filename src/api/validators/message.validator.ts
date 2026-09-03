// Schema cho router `message` (FR-6, task 013).
//
// `message.route.ts` có 8 route, tất cả sau `protectRoute` — 7/8 route cần schema, riêng
// `FAKE_CONVERSATIONS_MSGS` không đọc body nên không cần (không export const cho route này).
import { z } from "zod";
import { sanitizeText } from "../middlewares/sanitize.js";
import { objectIdSchema } from "./common.ts";

// Bước 9 (access-control-hardening): `userId` ĐÃ BỎ — một trong hai participant luôn là người gọi
// (`req.user._id`). Khai báo nó ở đây chính là thứ cho phép tra hội thoại riêng tư của 2 người bất kỳ.
export const getConversationByUsersIdSchema = {
  body: z.object({
    anotherId: objectIdSchema,
  }),
};

// Bước 9: `userId` ĐÃ BỎ — chỉ dùng để chọn "người còn lại" khi dựng response, giờ lấy từ JWT.
export const getConversationByIdQuerySchema = {
  query: z.object({
    conversationId: objectIdSchema,
  }),
};

const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).optional(),
});

export const getConversationMediaSchema = {
  params: z.object({
    conversationId: objectIdSchema,
  }),
  query: paginationQuerySchema,
};

export const getConversationFilesSchema = {
  params: z.object({
    conversationId: objectIdSchema,
  }),
  query: paginationQuerySchema,
};

export const getConversationLinksSchema = {
  params: z.object({
    conversationId: objectIdSchema,
  }),
  query: paginationQuerySchema,
};

// `page`/`limit` tới từ JSON body (không phải query string) -> `z.number()`, KHÔNG
// `z.coerce.number()` — formalize hoá đúng check "Empty payload" đã có sẵn ở controller
// (`message.controller.ts:169-172`), sớm hơn 1 tầng.
// FR-3 (task 010): field free-text duy nhất trong file này — tương đương `searchValue` bên socket
// đã có `sanitizeText` từ lâu. `value` luôn required (`.min(1)`) nên không cần guard undefined.
export const searchMsgSchema = {
  body: z.object({
    value: z.string().min(1).transform((val) => sanitizeText(val)),
    conversationId: objectIdSchema,
    page: z.number().int().min(1),
    limit: z.number().int().min(1),
  }),
};

// `numberConversations` optional -> `genConversations`/`handleFakeConversations` tự default 5
// khi thiếu (`src/api/crawl.ts`), schema không đặt default để không đổi hành vi đó.
export const handleFakeConversationsSchema = {
  body: z.object({
    userId: objectIdSchema,
    numberConversations: z.number().int().positive().optional(),
  }),
};
