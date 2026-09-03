import mongoose from "mongoose";
import { z } from "zod";

export const objectIdSchema = z
  .string()
  .refine((val) => mongoose.isValidObjectId(val), {
    message: "Invalid ObjectId",
  });

export { sanitizeText, sanitizeNoSqlPayload } from "../../api/middlewares/sanitize.js";

export const checkPayloadSize = (
  payload: any,
  maxBytes: number = 25 * 1024 * 1024
): boolean => {
  if (!payload) return true;
  try {
    const serialized = JSON.stringify(payload);
    return Buffer.byteLength(serialized, "utf8") <= maxBytes;
  } catch {
    return false;
  }
};

export const sendMessageSchema = z.object({
  recipientId: objectIdSchema,
  senderId: z.string().optional(),
  message: z.object({
    content: z.string().max(5000, "Content cannot exceed 5000 characters").optional(),
    media: z
      .array(
        z.object({
          url: z.string().max(15 * 1024 * 1024, "Media item cannot exceed 15MB"),
          type: z.string().max(50),
        })
      )
      .max(10, "Maximum 10 media items allowed")
      .optional(),
    files: z.array(objectIdSchema).max(10, "Maximum 10 files allowed").optional(),
    respondTo: objectIdSchema.optional(),
  }),
});

export const getConversationsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(15).optional(),
  searchValue: z.string().max(100).optional(),
});

export const getMessagesSchema = z.object({
  conversationId: objectIdSchema,
  page: z.coerce.number().int().min(1).default(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30).optional(),
});

export const getMsgsToSearchMsgSchema = z.object({
  conversationId: objectIdSchema,
  searchMsgId: objectIdSchema,
  limit: z.coerce.number().int().min(1).max(100).default(30).optional(),
  currentPage: z.coerce.number().int().min(1).default(1).optional(),
});

export const reactMsgSchema = z.object({
  msgId: objectIdSchema,
  react: z.string().min(1).max(50),
});

export const changeSettingConversationSchema = z.object({
  conversationId: objectIdSchema,
  key: z.enum(["theme", "emoji"]),
  value: z.string().min(1).max(100),
  changeSettingContent: z.string().max(500).optional(),
});

export const retrieveMsgSchema = z.object({
  msgId: objectIdSchema,
});

export const updateLastSeenSchema = z.object({
  lastMsg: z.object({
    _id: objectIdSchema,
    conversationId: objectIdSchema,
    createdAt: z.any().optional(),
  }),
});

export const sendNextSchema = z.object({
  msgInfo: z.record(z.any()),
  conversationsInfo: z
    .array(
      z.object({
        _id: objectIdSchema,
        recipientId: objectIdSchema,
      })
    )
    .min(1, "At least 1 conversation required")
    .max(50, "Maximum 50 conversations allowed"),
});
