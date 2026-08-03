import express from "express";
import { POST_PATH } from "../../Breads-Shared/APIConfig.js";
import {
  createPost,
  deletePost,
  getPost,
  getPosts,
  likeUnlikePost,
  tickPostSurvey,
  updatePost,
  updatePostStatus,
} from "../controllers/post.controller.js";
import { crawlPosts } from "../crawl.js";
import optionalAuth from "../middlewares/optionalAuth.js";
import protectRoute from "../middlewares/protectRoute.js";
import Post from "../models/post.model.js";
import asyncHandler from "../../helpers/asyncHandler.js";

const router = express.Router();
const {
  GET_ALL,
  CREATE,
  UPDATE,
  LIKE,
  TICK_SURVEY,
  CRAWL_POST,
  UPDATE_POST_STATUS,
} = POST_PATH;

router.get(GET_ALL, asyncHandler(getPosts));
router.get("/:id", optionalAuth, asyncHandler(getPost));
router.post(CREATE, createPost);
router.delete("/:id", asyncHandler(deletePost));
router.put(UPDATE, asyncHandler(updatePost));
router.post(LIKE + ":id", protectRoute, asyncHandler(likeUnlikePost));
router.put(TICK_SURVEY, asyncHandler(tickPostSurvey));
router.post(CRAWL_POST, asyncHandler(crawlPosts));
router.post(UPDATE_POST_STATUS, asyncHandler(updatePostStatus));

export default router;
