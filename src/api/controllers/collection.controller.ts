import PageConstant from "../../Breads-Shared/Constants/PageConstants.js";
import { CREATED, OK } from "../../core/success.response.js";
import { BadRequestError, NotFoundError } from "../../core/error.response.js";
import { ObjectId } from "../../utils/index.js";
import SavedPost from "../models/savedPost.model.js";
import { getPostDetail, getPostsIdByFilter } from "../services/post.js";

export const getUserCollection = async (req, res) => {
  const userId = req.params.userId;
  const savedPosts = await SavedPost.find({ userId: ObjectId(userId) }).sort({
    createdAt: -1,
  });
  new OK({
    message: "User collection fetched successfully",
    metadata: {
      userId,
      postsId: savedPosts.map(({ postId }) => postId),
    },
  }).send(res);
};

export const addPostToCollection = async (req, res) => {
  const { userId } = req.params;
  const { postId } = req.body;
  if (!userId || !postId) {
    throw new BadRequestError("Empty payload");
  }
  const existing = await SavedPost.findOne({
    userId: ObjectId(userId),
    postId: ObjectId(postId),
  });
  if (existing) {
    new OK({
      message: "Post added to collection successfully",
      metadata: {},
    }).send(res);
    return;
  }
  await SavedPost.create({
    userId: ObjectId(userId),
    postId: ObjectId(postId),
  });
  new CREATED({
    message: "Post added to collection successfully",
    metadata: {},
  }).send(res);
};

export const removePostFromCollection = async (req, res) => {
  const { userId, postId } = req.params;
  if (!userId || !postId) {
    throw new BadRequestError("Empty payload");
  }
  const deleteResult = await SavedPost.deleteOne({
    userId: ObjectId(userId),
    postId: ObjectId(postId),
  });
  if (deleteResult.deletedCount === 0) {
    throw new NotFoundError("Post not found in collection");
  }
  const result = [];
  const postsId = await getPostsIdByFilter({
    filter: { page: PageConstant.SAVED },
    userId,
  });
  for (const id of postsId) {
    const postDetail = await getPostDetail(id);
    result.push(postDetail);
  }
  new OK({
    message: "Post removed from collection successfully",
    metadata: result,
  }).send(res);
};
