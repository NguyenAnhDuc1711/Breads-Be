import { z } from "zod";
import { objectIdSchema } from "./common.ts";

export const createEventSchema = {
  body: z.object({
    userId: objectIdSchema,
    event: z.string().min(1),
    payload: z.any().optional(),
    deviceInfo: z.record(z.string(), z.any()).optional(),
    browserInfo: z.record(z.string(), z.any()).optional(),
    localeInfo: z.record(z.string(), z.any()).optional(),
    webInfo: z.record(z.string(), z.any()).optional(),
  }),
};
