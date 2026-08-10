import { Router } from "express";
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
