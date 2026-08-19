// Schema cho router `collection` (FR-7, task 014; redesign RESTful task 013).
//
// 3 route: GET /:userId (params), PATCH /:userId/items (params + body), DELETE /:userId/items/:postId
// (params only). Không route nào có query nên không cần `z.coerce.*`.
import { z } from "zod";
import { objectIdSchema } from "./common.ts";

// `getUserCollection` KHÔNG check `userId` trước khi gọi `ObjectId(userId)`
// (`collection.controller.ts:8-10`) — param dị dạng hiện ném lỗi cast 500. Schema đưa về 400.
export const getUserCollectionSchema = {
  params: z.object({
    userId: objectIdSchema,
  }),
};

// Task 013 (D-1): userId chuyển vào path (PATCH /:userId/items), postId vẫn ở body.
export const addPostToCollectionSchema = {
  params: z.object({
    userId: objectIdSchema,
  }),
  body: z.object({
    postId: objectIdSchema,
  }),
};

// Task 013 (D-1): DELETE /:userId/items/:postId — cả 2 id vào path, không còn body.
export const removePostFromCollectionSchema = {
  params: z.object({
    userId: objectIdSchema,
    postId: objectIdSchema,
  }),
};
