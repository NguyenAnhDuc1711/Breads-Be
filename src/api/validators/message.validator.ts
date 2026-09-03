import { z } from "zod";
import { sanitizeText } from "../middlewares/sanitize.js";
import { objectIdSchema } from "./common.ts";

export const getConversationByUsersIdSchema = {
  body: z.object({
    anotherId: objectIdSchema,
  }),
};

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

export const searchMsgSchema = {
  body: z.object({
    value: z.string().min(1).transform((val) => sanitizeText(val)),
    conversationId: objectIdSchema,
    page: z.number().int().min(1),
    limit: z.number().int().min(1),
  }),
};

export const handleFakeConversationsSchema = {
  body: z.object({
    userId: objectIdSchema,
    numberConversations: z.number().int().positive().optional(),
  }),
};
