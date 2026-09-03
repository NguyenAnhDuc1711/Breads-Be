import { z } from "zod";
import { objectIdSchema } from "./common.ts";

export const MEDIA_SIGN_BATCH_MAX = 10;

export const MEDIA_TYPE_VALUES = ["image", "gif", "video"] as const;

const mediaSignItemSchema = z.object({
  type: z.enum(MEDIA_TYPE_VALUES),
});

const batchFields = {
  count: z.number().int().min(1).max(MEDIA_SIGN_BATCH_MAX),
  items: z.array(mediaSignItemSchema).min(1).max(MEDIA_SIGN_BATCH_MAX).optional(),
};

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
