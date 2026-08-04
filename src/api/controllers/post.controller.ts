import axios from "axios";
import { Constants } from "../../Breads-Shared/Constants/index.js";
import PostConstants from "../../Breads-Shared/Constants/PostConstants.js";
import { IPost } from "../../Breads-Shared/Types/index.js";
import { CREATED, OK } from "../../core/success.response.js";
import HTTPStatus from "../../utils/httpStatus.js";
import { ObjectId } from "../../utils/index.js";
import Category from "../models/category.model.js";
import Like from "../models/like.model.js";
import Link from "../models/link.model.js";
import Post from "../models/post.model.js";
import SurveyOption from "../models/surveyOption.model.js";
import User from "../models/user.model.js";
import { fanoutPostToFollowers } from "../services/feed/fanout.ts";
import {
  getPostDetail,
  getPostsIdByFilter,
  handleReplyForParentPost,
} from "../services/post.js";
import { uploadFileFromBase64 } from "../utils/index.js";

//create post
export const createPost = async (req, res) => {
  const payload = req.body;
  const action = req.query.action;
  const {
    _id,
    authorId,
    content,
    media,
    parentPost,
    survey,
    quote,
    type,
    usersTag,
    links,
    files,
  } = payload;
  const user = await User.findById(authorId);
  if (!user) {
    return res.status(HTTPStatus.NOT_FOUND).json({ error: "User not found" });
  }
  if (
    !content.trim() &&
    !media?.[0]?.url &&
    !survey.length &&
    !parentPost &&
    !quote?._id &&
    !files?.length
  ) {
    return res
      .status(HTTPStatus.BAD_REQUEST)
      .json({ error: "Cannot create post without payload" });
  }
  const maxLength = 500;
  if (content.length > maxLength) {
    return res
      .status(HTTPStatus.BAD_REQUEST)
      .json({ error: `Text must be less than ${maxLength} characters` });
  }
  let newMedia = [];
  if (media.length) {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    for (let fileInfo of media) {
      const isUrl = fileInfo.url.match(urlRegex)
        ? fileInfo.url.match(urlRegex)?.length > 0
        : false;
      if (!isUrl) {
        const mediaUrl = await uploadFileFromBase64({
          base64: fileInfo.url,
        });
        fileInfo.url = mediaUrl;
      }
      newMedia.push(fileInfo);
    }
  }
  let newSurvey = [];
  if (survey.length) {
    newSurvey = survey.map((option) => {
      const newOption = new SurveyOption({
        ...option,
        _id: ObjectId(),
        usersId: [],
      });
      return newOption;
    });
    for (let option of newSurvey) {
      await option.save();
    }
  }
  const optionsId = newSurvey.map((option) => option?._id);
  const linksId = [];
  if (links.length) {
    for (let i = 0; i < links.length; i++) {
      const newId = ObjectId();
      const linkInfo = links[i];
      const newLink = new Link({
        _id: newId,
        ...linkInfo,
      });
      await newLink.save();
      linksId[i] = newId;
    }
  }
  const newUsersTag = usersTag.map((userId) => ObjectId(userId));
  let categories = [];
  if (!!content.trim()) {
    try {
      const { data: relatedCategories } = await axios.post(
        process.env.PYTHON_SERVER + "/search",
        {
          query: content,
        },
      );
      console.log("relatedCategories: ", relatedCategories);
      if (relatedCategories?.length) {
        const catesQuery = await Category.find(
          {
            name: {
              $in: relatedCategories,
            },
          },
          { _id: 1 },
        );
        categories = catesQuery?.map(({ _id }) => _id);
      }
    } catch (err) {
      console.log("error when get related categories: ", err);
    }
  }
  const newPostPayload: any = {
    _id: ObjectId(_id),
    authorId,
    content,
    media: newMedia,
    survey: optionsId,
    quote,
    type: type,
    usersTag: newUsersTag,
    links: linksId,
    files,
    categories,
  };
  if (action === PostConstants.ACTIONS.REPOST) {
    newPostPayload.parentPost = parentPost;
  }
  const newPost = new Post(newPostPayload);
  const postSaved = await newPost.save();
  // Fan-out-on-write (FR-5). KHÔNG `await`: NFR-2 cấm fan-out chặn response — một tác giả gần
  // ngưỡng celebrity sẽ làm response treo hàng giây. `.catch()` là bắt buộc: rejection không bắt
  // chỉ rơi vào handler `unhandledRejection` toàn cục (001), mất hết ngữ cảnh.
  fanoutPostToFollowers({
    post: postSaved,
    io: req.app.get("socket_io"),
  }).catch((e) => console.log("[feed-fanout] error", e));
  if (parentPost && action === PostConstants.ACTIONS.REPLY) {
    await handleReplyForParentPost({
      parentId: parentPost,
      replyId: newPost._id,
      addNew: true,
    });
  }
  const result = await getPostDetail({
    postId: postSaved._id,
    viewerId: authorId,
  });
  new CREATED({
    message: "Create post successfully",
    metadata: result,
  }).send(res);
};

//get post
export const getPost = async (req, res) => {
  const postId = ObjectId(req.params.id);
  const post: IPost | null = await getPostDetail({
    postId,
    getFullInfo: true,
    viewerId: req.viewerId,
  });
  if (!post) {
    return res.status(HTTPStatus.NOT_FOUND).json({ error: "Post not found!" });
  }
  new OK({
    message: "Get post successfully",
    metadata: post,
  }).send(res);
};
//delete Post
export const deletePost = async (req, res) => {
  const postId = req.params.id;
  const userId = req.query.userId;
  if (!postId || !userId) {
    return res.status(HTTPStatus.BAD_REQUEST).json({ error: "Empty payload" });
  }
  const post = await Post.findById(postId);
  if (!post) {
    return res.status(HTTPStatus.NOT_FOUND).json({ error: "Post not found" });
  }
  if (post.authorId.toString() !== userId.toString()) {
    return res
      .status(HTTPStatus.UNAUTHORIZED)
      .json({ error: "Unauthorized to delete post" });
  }
  const repliesId = post.replies;
  if (repliesId?.length) {
    await Post.updateMany(
      { _id: { $in: repliesId } },
      {
        status: Constants.POST_STATUS.DELETED,
      },
    );
  }
  await Post.updateMany(
    {
      replies: postId,
    },
    {
      $pull: {
        replies: postId,
      },
      $inc: { engagementScore: -3 },
    },
  );
  await Post.updateMany(
    { "quote._id": postId },
    {
      quote: {},
    },
  );
  await Post.updateOne(
    {
      _id: ObjectId(postId),
    },
    {
      status: Constants.POST_STATUS.DELETED,
    },
  );
  new OK({
    message: "Post deleted successfully!",
    metadata: {},
  }).send(res);
};
//updatePost
export const updatePost = async (req, res) => {
  const payload = req.body;
  const postId = payload._id;
  const { media, content, survey } = payload;
  // if(!req.user){
  //   return res.status(HTTPStatus.UNAUTHORIZED).json({error: "Unauthorized"})
  // }
  let post = await Post.findById(postId);
  if (!post) {
    return res.status(HTTPStatus.NOT_FOUND).json({ error: "Post not found" });
  }

  if (post.authorId.toString() !== payload.userId.toString()) {
    return res
      .status(HTTPStatus.UNAUTHORIZED)
      .json({ error: "Unauthorized to update this post" });
  }
  let newSurvey = [];
  if (survey.length) {
    newSurvey = survey
      .filter((option) => !!option.value)
      .map((option) => {
        const newOption = new SurveyOption({
          placeholder: option.placeholder,
          value: option.value,
          _id: ObjectId(),
          usersId: [],
        });
        return newOption;
      });
    for (let option of newSurvey) {
      await option.save();
    }
  }
  post.content = content;
  post.media = media;
  post.survey = newSurvey;
  post = await post.save();
  new OK({
    message: "Post updated successfully!",
    metadata: post,
  }).send(res);
};

//like and unlike post
export const likeUnlikePost = async (req, res) => {
  const { id: postId } = req.params;
  const userId = req.user._id;

  const post = await Post.findById(postId);
  if (!post) {
    return res.status(HTTPStatus.NOT_FOUND).json({ error: "Post not found" });
  }
  const existingLike = await Like.findOne({
    postId: ObjectId(postId),
    userId: ObjectId(userId),
  });
  let returnMsg = "";
  if (existingLike) {
    //unlike post
    await Like.deleteOne({ _id: existingLike._id });
    await Post.updateOne(
      { _id: post._id },
      { $inc: { likesCount: -1, engagementScore: -3 } },
    );
    returnMsg = "Post unliked successfully";
  } else {
    //like post
    await Like.create({ postId: ObjectId(postId), userId: ObjectId(userId) });
    await Post.updateOne(
      { _id: post._id },
      { $inc: { likesCount: 1, engagementScore: 3 } },
    );
    returnMsg = "Post liked successfully!";
  }

  new OK({
    message: returnMsg,
    metadata: {},
  }).send(res);
};

export const getPosts = async (req, res) => {
  const payload = req.query;
  const filter = payload?.filter;
  const pageFilter = filter?.page;
  const userId = payload.userId;
  const isAdminPage = pageFilter?.includes("admin");
  if (isAdminPage) {
    payload.isAdminPage = true;
  }
  const data = await getPostsIdByFilter(payload);
  let result = [];
  if (data?.length) {
    result = await getPostDetail({ postIds: data, viewerId: userId });
  }
  new OK({
    message: "Get posts successfully",
    metadata: result,
  }).send(res);
};

export const tickPostSurvey = async (req, res) => {
  const { optionId, userId, isAdd } = req.body;
  if (!optionId || !userId) {
    return res.status(HTTPStatus.BAD_REQUEST).json({ error: "Empty payload" });
  }
  if (isAdd) {
    await SurveyOption.updateOne(
      { _id: ObjectId(optionId) },
      {
        $push: { usersId: userId },
      },
    );
  } else {
    await SurveyOption.updateOne(
      { _id: ObjectId(optionId) },
      {
        $pull: { usersId: userId },
      },
    );
  }
  new OK({
    message: "OK",
    metadata: {},
  }).send(res);
};

export const updatePostStatus = async (req, res) => {
  const { userId, postId, status } = req.body;
  if (!userId || !postId) {
    return res.status(HTTPStatus.BAD_REQUEST).json({ error: "Empty payload" });
  }
  const userInfo = await User.findOne({
    _id: ObjectId(userId),
  });
  const isAdmin = userInfo?.role === Constants.USER_ROLE.ADMIN;
  if (!isAdmin) {
    return res
      .status(HTTPStatus.UNAUTHORIZED)
      .json({ error: "Only for admin" });
  }
  await Post.updateOne(
    {
      _id: ObjectId(postId),
    },
    {
      status: status,
    },
  );
  new OK({
    message: "OK",
    metadata: {},
  }).send(res);
};
