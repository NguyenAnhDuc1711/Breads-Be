import { z } from "zod";
import { objectIdSchema, paginationQuerySchema, rankedCursorSchema } from "./common.ts";

export const getUserProfileSchema = {
  params: z.object({ userId: objectIdSchema }),
};

export const signupUserSchema = {
  body: z.object({
    name: z.string().min(1),
    email: z.string().email(),
    username: z.string().min(1),
    password: z.string().min(1),
  }),
};

export const loginUserSchema = {
  body: z.object({
    email: z.string().email(),
    password: z.string().min(1),
  }),
};

export const followUserSchema = {
  body: z.object({
    userFlId: objectIdSchema,
  }),
};

export const updateUserSchema = {
  params: z.object({ id: objectIdSchema }),
  body: z.object({
    name: z.string().optional(),
    username: z.string().optional(),
    avatar: z.string().optional(),
    bio: z.string().optional(),
    links: z.array(z.string()).optional(),
  }),
};

export const getUserAdminDetailSchema = {
  params: z.object({ id: objectIdSchema }),
};

export const adminUpdateUserSchema = {
  params: z.object({ id: objectIdSchema }),
  body: z.object({
    role: z.number().optional(),
    status: z.number().optional(),
    reason: z.string().optional(),
  }),
};

export const changePasswordSchema = {
  params: z.object({ id: objectIdSchema }),
  body: z.object({
    currentPW: z.string().min(1),
    newPW: z.string().min(6),
  }),
};

export const requestPasswordResetSchema = {
  body: z.object({ email: z.string().email() }),
};

const resetCodeSchema = z.string().length(6);

export const verifyPasswordResetCodeSchema = {
  body: z.object({ email: z.string().email(), code: resetCodeSchema }),
};

export const confirmPasswordResetSchema = {
  body: z.object({
    userId: objectIdSchema,
    code: resetCodeSchema,
    newPW: z.string().min(6),
  }),
};

export const validateEmailByCodeSchema = {
  body: z.object({
    email: z.string().email(),
    code: z.string().min(1),
  }),
};

export const getUsersFollowQuerySchema = {
  query: z.object({
    ...paginationQuerySchema.shape,
    limit: paginationQuerySchema.shape.limit.unwrap().max(50).optional(),
    userId: objectIdSchema,
    type: z.enum(["followed", "following"]),
  }),
};

export const getUserToFollowsQuerySchema = {
  query: z.object({
    ...paginationQuerySchema.shape,
    userId: objectIdSchema.optional(),
    searchValue: z.string().optional(),
    isTest: z
      .enum(["true", "false"])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === "true")),
  }),
};

export const getUsersToTagQuerySchema = {
  query: z.object({
    ...paginationQuerySchema.shape,
    userId: objectIdSchema,
    searchValue: z.string().optional(),
  }),
};

export const getUsersWithStatusQuerySchema = {
  query: z.object({
    ...paginationQuerySchema.shape,
    searchValue: z.string().optional(),
    role: z.coerce.number().optional(),
    status: z.coerce.number().optional(),
    dateFrom: z.coerce.date().optional(),
    dateTo: z.coerce.date().optional(),
  }),
};

export const getUsersPendingPostSchema = {
  body: z.object({
    ...paginationQuerySchema.shape,
    searchValue: z.string().optional(),
  }),
};


export const getSitemapEligibleUsersQuerySchema = {
  query: z.object({
    cursor: rankedCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(1000).optional().default(1000),
  }),
};
