import express, { Router } from "express";
import mongoSanitize from "express-mongo-sanitize";
import hpp from "hpp";
import {
  addPostToCollection,
  getUserCollection,
  removePostFromCollection,
} from "../controllers/collection.controller.js";
import protectRoute from "../middlewares/protectRoute.js";
import { requireSelfOnParam } from "../middlewares/requireRole.js";
import { COLLECTION_PATH } from "../../Breads-Shared/APIConfig.js";
import asyncHandler from "../../helpers/asyncHandler.ts";
import { validate } from "../middlewares/validate.ts";
import {
  addPostToCollectionSchema,
  getUserCollectionSchema,
  removePostFromCollectionSchema,
} from "../validators/collection.validator.ts";

const router = Router();
router.use(express.json({ limit: "1mb" }));
router.use(mongoSanitize());
router.use(hpp());
const { ADD, REMOVE } = COLLECTION_PATH;

router.get(
  "/:userId",
  protectRoute,
  requireSelfOnParam("userId"),
  validate(getUserCollectionSchema),
  asyncHandler(getUserCollection)
);
router.patch(
  ADD,
  protectRoute,
  requireSelfOnParam("userId"),
  validate(addPostToCollectionSchema),
  asyncHandler(addPostToCollection)
);
router.delete(
  REMOVE,
  protectRoute,
  requireSelfOnParam("userId"),
  validate(removePostFromCollectionSchema),
  asyncHandler(removePostFromCollection)
);

export default router;
