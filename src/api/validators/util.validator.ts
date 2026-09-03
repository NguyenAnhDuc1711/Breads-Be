import { z } from "zod";
import { objectIdSchema } from "./common.ts";

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
