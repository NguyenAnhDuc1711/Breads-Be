import mongoose from "mongoose";
import { z } from "zod";

export const objectIdSchema = z
  .string()
  .refine(mongoose.isValidObjectId, "invalid id");

export const rankedCursorSchema = z
  .string()
  .refine((v) => {
    const parts = v.split(":");
    if (parts.length !== 2) return false;
    const [score, id] = parts;
    return /^\d+$/.test(score) && mongoose.isValidObjectId(id);
  }, "invalid cursor — expected format \"score:id\"");

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).optional(),
});
