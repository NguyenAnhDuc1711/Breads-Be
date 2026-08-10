// Schema cho router `collection` (FR-7, task 014).
//
// 3 route: 1 đọc `req.params` (`GET /:userId`), 2 đọc `req.body`. Không route nào có query nên
// không cần `z.coerce.*`.
import { z } from "zod";
import { objectIdSchema } from "./common.ts";

// `getUserCollection` KHÔNG check `userId` trước khi gọi `ObjectId(userId)`
// (`collection.controller.ts:8-10`) — param dị dạng hiện ném lỗi cast 500. Schema đưa về 400.
export const getUserCollectionSchema = {
  params: z.object({
    userId: objectIdSchema,
  }),
};

export const addPostToCollectionSchema = {
  body: z.object({
    userId: objectIdSchema,
    postId: objectIdSchema,
  }),
};

export const removePostFromCollectionSchema = {
  body: z.object({
    postId: objectIdSchema,
    userId: objectIdSchema,
  }),
};
