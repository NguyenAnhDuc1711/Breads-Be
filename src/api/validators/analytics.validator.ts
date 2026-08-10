// Schema cho router `analytics` (FR-8, task 015).
//
// `analytics.route.ts` có 2 route, chỉ CREATE cần schema. `getEvents` không đọc field nào từ
// `req.body` (body-destructure đang comment out, `analytics.controller.ts:47`) nên không export
// schema cho route đó — tránh validate suông cho field controller không dùng.
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
