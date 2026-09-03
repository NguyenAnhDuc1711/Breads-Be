import { z } from "zod";
import { objectIdSchema } from "./common.ts";

export const getReportsSchema = {
  query: z.object({
    searchValue: z.string().optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).optional(),
  }),
};

export const sendReportSchema = {
  body: z.object({
    content: z.string().optional(),
    media: z.array(z.any()).optional(),
  }),
};

export const responseReportSchema = {
  params: z.object({
    id: objectIdSchema,
  }),
  body: z.object({
    subject: z.string().min(1),
    html: z.string().optional(),
  }),
};

export const rejectReportSchema = {
  params: z.object({
    id: objectIdSchema,
  }),
  body: z.object({
  }),
};

export const getReportsByUserSchema = {
  params: z.object({
    id: objectIdSchema,
  }),
};
