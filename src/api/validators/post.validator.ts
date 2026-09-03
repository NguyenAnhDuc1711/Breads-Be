import { z } from "zod";
import { Constants } from "../../Breads-Shared/Constants/index.js";
import { sanitizeText } from "../middlewares/sanitize.js";
import { objectIdSchema, paginationQuerySchema, rankedCursorSchema } from "./common.js";

const VISIBILITY_VALUES: number[] = Object.values(Constants.POST_VISIBILITY);

const visibilitySchema = z
  .number()
  .refine((v) => VISIBILITY_VALUES.includes(v), "invalid visibility");

const optionalObjectIdOrEmpty = z.union([objectIdSchema, z.literal("")]);

export const getPostsQuerySchema = {
  query: paginationQuerySchema.extend({
    filter: z
      .object({
        page: z.string(),
        value: z.string().optional(),
        user: optionalObjectIdOrEmpty.optional(),
      })
      .passthrough(),
    userId: optionalObjectIdOrEmpty.optional(),
  }),
};

export const getPostSchema = {
  params: z.object({ id: objectIdSchema }),
};

export const createPostSchema = {
  body: z.object({
    _id: objectIdSchema,
    content: z.string().max(500).transform((val) => sanitizeText(val)),
    media: z.array(z.any()).optional(),
    parentPost: objectIdSchema.optional(),
    survey: z.array(z.any()).optional(),
    quote: z.any().optional(),
    type: z.string(),
    usersTag: z.array(objectIdSchema).optional(),
    links: z.array(z.any()).optional(),
    files: z.array(z.any()).optional(),
    visibility: visibilitySchema.optional(),
  }),
  query: z.object({ action: z.string().optional() }),
};

export const deletePostSchema = {
  params: z.object({ id: objectIdSchema }),
  query: z.object({}),
};

export const updatePostSchema = {
  body: z.object({
    _id: objectIdSchema,
    content: z
      .string()
      .max(500)
      .optional()
      .transform((val) => (val === undefined ? val : sanitizeText(val))),
    media: z.array(z.any()).optional(),
    survey: z.array(z.any()).optional(),
    visibility: z.number().optional(),
    files: z.array(z.any()).optional(),
  }),
};

export const likeUnlikePostSchema = {
  params: z.object({ id: objectIdSchema }),
};

export const tickPostSurveySchema = {
  body: z.object({
    optionId: objectIdSchema,
    isAdd: z.boolean(),
  }),
};

const POST_STATUS_VALUES: number[] = Object.values(Constants.POST_STATUS);

export const updatePostStatusSchema = {
  params: z.object({
    id: objectIdSchema,
  }),
  body: z.object({
    status: z.number().refine(
      (v) => POST_STATUS_VALUES.includes(v),
      "invalid status",
    ),
  }),
};

export const updatePostVisibilitySchema = {
  params: z.object({
    id: objectIdSchema,
  }),
  body: z.object({
    visibility: visibilitySchema,
  }),
};

export const getPostActivitiesSchema = {
  params: z.object({ id: objectIdSchema }),
  query: z.object({
    type: z.enum(["likes", "comments", "reposts"]).optional(),
    page: z.coerce.number().optional(),
    limit: z.coerce.number().optional(),
  }),
};

export const getPostRepliesSchema = {
  params: z.object({ id: objectIdSchema }),
  query: z.object({
    page: z.coerce.number().optional(),
    limit: z.coerce.number().optional(),
  }),
};

export const getSitemapEligiblePostsQuerySchema = {
  query: z.object({
    cursor: rankedCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(1000).optional().default(1000),
  }),
};

