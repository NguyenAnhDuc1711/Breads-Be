import { z } from "zod";
import { objectIdSchema } from "./common.ts";

export const getUserCollectionSchema = {
  params: z.object({
    userId: objectIdSchema,
  }),
};

export const addPostToCollectionSchema = {
  params: z.object({
    userId: objectIdSchema,
  }),
  body: z.object({
    postId: objectIdSchema,
  }),
};

export const removePostFromCollectionSchema = {
  params: z.object({
    userId: objectIdSchema,
    postId: objectIdSchema,
  }),
};
