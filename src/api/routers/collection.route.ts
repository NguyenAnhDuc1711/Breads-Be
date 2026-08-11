import express, { Router } from "express";
import mongoSanitize from "express-mongo-sanitize";
import hpp from "hpp";
import {
  addPostToCollection,
  getUserCollection,
  removePostFromCollection,
} from "../controllers/collection.controller.js";
// import protectRoute from "../middlewares/protectRoute.js";
import { COLLECTION_PATH } from "../../Breads-Shared/APIConfig.js";
import asyncHandler from "../../helpers/asyncHandler.ts";
import { validate } from "../middlewares/validate.ts";
import {
  addPostToCollectionSchema,
  getUserCollectionSchema,
  removePostFromCollectionSchema,
} from "../validators/collection.validator.ts";

const router = Router();
// FR-2 (task 010): chỉ nhận id/paging, không có field lớn -> 1mb.
router.use(express.json({ limit: "1mb" }));
// FR-5 (task 013): sanitize NoSQL operator + HPP.
router.use(mongoSanitize());
router.use(hpp());
const { ADD, REMOVE } = COLLECTION_PATH;

router.get(
  "/:userId",
  validate(getUserCollectionSchema),
  asyncHandler(getUserCollection)
);
router.patch(
  ADD,
  validate(addPostToCollectionSchema),
  asyncHandler(addPostToCollection)
);
router.patch(
  REMOVE,
  validate(removePostFromCollectionSchema),
  asyncHandler(removePostFromCollection)
);

export default router;
