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
  // Task 013 (D-1 / plan-review edge case): postId không tồn tại trong collection -> 404, nhất
  // quán với hành vi DELETE resource không tồn tại ở /posts/:id.
  if (deleteResult.deletedCount === 0) {
    throw new NotFoundError("Post not found in collection");
  }
  const result = [];
  const postsId = await getPostsIdByFilter({
    filter: { page: PageConstant.SAVED },
    userId,
  });
  for (const id of postsId) {
    // Task 010 / ARCH-1: `getPostDetail` nhận 1 OBJECT tham số. Bản cũ truyền thẳng `id` nên
    // `postId` destructure ra `undefined` -> `ObjectId("")` sinh id NGẪU NHIÊN -> luôn trả `null`,
    // endpoint này trả về mảng toàn `null`. Sửa để response thật sự đi qua điểm serialize dùng
    // chung (và do đó phản ánh đúng bước lọc field rỗng), đúng như FR-6 yêu cầu.
    const postDetail = await getPostDetail({ postId: id });
    result.push(postDetail);
  }
  new OK({
    message: "Post removed from collection successfully",
    metadata: result,
  }).send(res);
};
