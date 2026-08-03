import { Router } from "express";
import {
  addPostToCollection,
  getUserCollection,
  removePostFromCollection,
} from "../controllers/collection.controller.js";
// import protectRoute from "../middlewares/protectRoute.js";
import { COLLECTION_PATH } from "../../Breads-Shared/APIConfig.js";
import asyncHandler from "../../helpers/asyncHandler.ts";

const router = Router();
const { ADD, REMOVE } = COLLECTION_PATH;

router.get("/:userId", asyncHandler(getUserCollection));
router.patch(ADD, asyncHandler(addPostToCollection));
router.patch(REMOVE, asyncHandler(removePostFromCollection));

export default router;
