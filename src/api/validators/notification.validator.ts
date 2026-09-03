import { z } from "zod";
import { Constants } from "../../Breads-Shared/Constants/index.js";
import { objectIdSchema } from "./common.ts";

export const getNotificationsSchema = {
  query: z.object({
    page: z.coerce.number().int().min(1),
    limit: z.coerce.number().int().min(1),
    action: z.enum(Constants.NOTIFICATION_ACTION).optional(),
  }),
};

export const readNotificationsSchema = {
  body: z
    .object({
      notificationId: objectIdSchema.optional(),
      markAll: z.literal(true).optional(),
    })
    .refine(
      (b) => Boolean(b.notificationId) !== Boolean(b.markAll),
      "đúng 1 trong 2: notificationId HOẶC markAll"
    ),
};
