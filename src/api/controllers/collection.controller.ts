import PageConstant from "../../Breads-Shared/Constants/PageConstants.js";
import { CREATED, OK } from "../../core/success.response.js";
import { BadRequestError } from "../../core/error.response.js";
import { ObjectId } from "../../utils/index.js";
import Collection from "../models/collection.model.js";
import { getPostDetail, getPostsIdByFilter } from "../services/post.js";

export const getUserCollection = async (req, res) => {
  const userId = req.params.userId;
  const data = await Collection.findOne({ userId: ObjectId(userId) });
  new OK({
    message: "User collection fetched successfully",
    metadata: data,
  }).send(res);
};

export const addPostToCollection = async (req, res) => {
  const { userId, postId } = req.body;
  if (!userId || !postId) {
    throw new BadRequestError("Empty payload");
  }
  const isValidCollection = await Collection.findOne({
    userId: ObjectId(userId),
  });
  if (isValidCollection) {
    await Collection.findOneAndUpdate(
      {
        userId: ObjectId(userId),
      },
      {
        $push: { postsId: postId },
      }
    );
    new OK({
      message: "Post added to collection successfully",
      metadata: {},
    }).send(res);
  } else {
    const newCollection = new Collection({
      userId: ObjectId(userId),
      postsId: [postId],
    });
    await newCollection.save();
    new CREATED({
      message: "Post added to collection successfully",
      metadata: {},
    }).send(res);
  }
};

export const removePostFromCollection = async (req, res) => {
  const { postId, userId } = req.body;
  if (!userId || !postId) {
    throw new BadRequestError("Empty payload");
  }
  await Collection.findOneAndUpdate(
    {
      userId: ObjectId(userId),
    },
    {
      $pull: { postsId: postId },
    }
  );
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
