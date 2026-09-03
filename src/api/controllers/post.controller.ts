import axios from "axios";
import { SITEMAP_MAX_RECORDS } from "../../Breads-Shared/APIConfig.js";
import { Constants } from "../../Breads-Shared/Constants/index.js";
import PostConstants from "../../Breads-Shared/Constants/PostConstants.js";
import { IPost } from "../../Breads-Shared/Types/index.js";
import { CREATED, OK } from "../../core/success.response.js";
import {
  ForbiddenError,
  AuthFailureError,
  BadRequestError,
  NotFoundError,
} from "../../core/error.response.js";
import logger from "../../core/logger.js";
import { ObjectId } from "../../utils/index.js";
import Category from "../models/category.model.js";
import Follow from "../models/follow.model.js";
import Like from "../models/like.model.js";
import Link from "../models/link.model.js";
import Post from "../models/post.model.js";
import SurveyOption from "../models/surveyOption.model.js";
import User from "../models/user.model.js";
import { FEED_CONFIG } from "../services/feed/config.ts";
import { fanoutPostToFollowers } from "../services/feed/fanout.ts";
import { dispatchQueue } from "../services/feed/queue.ts";
import { isMediaLegacyFallbackEnabled } from "../services/mediaConvention.ts";
import {
  getFolloweeIds,
  getPostDetail,
  getPostsIdByFilter,
  getReplyPage,
  handleReplyForParentPost,
} from "../services/post.js";
import { uploadFileFromBase64 } from "../utils/index.js";
import { validateMediaUrl } from "../validators/validateMediaUrl.ts";
import { assertRole } from "../middlewares/requireRole.js";

export const isRepostLikePayload = (payload: {
  action?: string;
  type?: string;
  quote?: { _id?: any };
}): boolean =>
  payload.action === PostConstants.ACTIONS.REPOST ||
  payload.type === PostConstants.ACTIONS.REPOST ||
  !!payload.quote?._id;

export const validateRepostGuard = (
  referencedPostDoc: { visibility?: number } | null | undefined,
): { ok: true } | { ok: false; error: string } => {
  if (!referencedPostDoc) {
    return { ok: false, error: "Parent post not found" };
  }
  if (referencedPostDoc.visibility !== Constants.POST_VISIBILITY.PUBLIC) {
    return { ok: false, error: "Cannot repost non-public content" };
  }
  return { ok: true };
};

export const dispatchFanout = (
  postSaved: { _id: any; authorId: any },
  io: any,
  deps: {
    fanoutDirect?: (args: { post: any; io: any }) => Promise<any>;
    enqueue?: (name: string, data: any, opts: any) => Promise<any>;
  } = {},
): void => {
  const fanoutDirect = deps.fanoutDirect ?? fanoutPostToFollowers;
  const enqueue = deps.enqueue ?? dispatchQueue.add.bind(dispatchQueue);

  if (FEED_CONFIG.fanoutMode === "direct") {
    fanoutDirect({ post: postSaved, io }).catch((e) =>
      logger.error({ err: e }, "[feed-fanout] direct fan-out failed"),
    );
    return;
  }
  if (FEED_CONFIG.fanoutEnabled) {
    enqueue(
      "fanout-post",
      { postId: String(postSaved._id), authorId: String(postSaved.authorId) },
      {
        jobId: String(postSaved._id),
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    ).catch((e) => logger.error({ err: e }, "[feed-fanout] enqueue failed"));
  }
};

export const processNewPostMediaItem = async (
  item: { url: string; type?: string; [key: string]: any },
  authorId: string,
): Promise<{ url: string; type?: string; [key: string]: any } | null> => {
  if (item.type === Constants.MEDIA_TYPE.GIF) {
    return item;
  }
  if (
    isMediaLegacyFallbackEnabled() &&
    typeof item.url === "string" &&
    item.url.startsWith("data:")
  ) {
    const mediaUrl = await uploadFileFromBase64({ base64: item.url });
    return { ...item, url: mediaUrl };
  }
  if (
    !validateMediaUrl(item.url, { namespace: "post", expectedKey: authorId })
  ) {
    return null;
  }
  return item;
};

//create post
export const createPost = async (req, res) => {
  const payload = req.body;
  const action = req.query.action;
  const {
    _id,
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
  const authorId = String(req.user._id);
  if (
    !content.trim() &&
    !media?.[0]?.url &&
    !survey.length &&
    !parentPost &&
    !quote?._id &&
    !files?.length
  ) {
    throw new BadRequestError("Cannot create post without payload");
  }
  const maxLength = 500;
  if (content.length > maxLength) {
    throw new BadRequestError(`Text must be less than ${maxLength} characters`);
  }
  const validVisibilityValues: number[] = Object.values(
    Constants.POST_VISIBILITY,
  );
  if (
    payload.visibility !== undefined &&
    !validVisibilityValues.includes(payload.visibility)
  ) {
    throw new BadRequestError("Invalid visibility value");
  }
  let newMedia = [];
  if (media.length) {
    for (let fileInfo of media) {
      const processed = await processNewPostMediaItem(fileInfo, authorId);
      if (!processed) {
        throw new BadRequestError(`Invalid media URL: ${fileInfo.url}`);
      }
      newMedia.push(processed);
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
      logger.error({ err }, "get related categories failed");
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
    visibility: payload.visibility ?? Constants.POST_VISIBILITY.PUBLIC,
  };
  if (isRepostLikePayload({ action, type, quote })) {
    const referencedPostId = parentPost || quote?._id;
    const parentPostDoc = await Post.findById(referencedPostId, {
      visibility: 1,
    });
    const guard = validateRepostGuard(parentPostDoc);
    if (guard.ok === false) {
      throw new BadRequestError(guard.error);
    }
    if (action === PostConstants.ACTIONS.REPOST) {
      newPostPayload.parentPost = parentPost;
    }
  }
  if (parentPost && action === PostConstants.ACTIONS.REPLY) {
    newPostPayload.parentPost = parentPost;
  }
  const newPost = new Post(newPostPayload);
  const postSaved = await newPost.save();
  dispatchFanout(postSaved, req.app.get("socket_io"));
  if (parentPost && action === PostConstants.ACTIONS.REPLY) {
    await handleReplyForParentPost({
      parentId: parentPost,
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
    viewerId: req.viewerId,
  });
  if (!post) {
    throw new NotFoundError("Post not found!");
  }
  new OK({
    message: "Get post successfully",
    metadata: post,
  }).send(res);
};

export const getPostReplies = async (req, res) => {
  const { id: postId } = req.params;
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const page = Math.max(Number(req.query.page) || 1, 1);

  const post = await Post.findById(postId, { _id: 1 }).lean();
  if (!post) {
    throw new NotFoundError("Post not found");
  }

  const viewerId = req.viewerId;
  const followeeIds = viewerId ? await getFolloweeIds(viewerId) : [];
  const { ids, total } = await getReplyPage({
    postId,
    viewerId,
    followeeIds,
    page,
    limit,
  });
  const replies = ids.length
    ? await getPostDetail({ postIds: ids, viewerId, followeeIds })
    : [];

  new OK({
    message: "Get post replies successfully",
    metadata: { replies, total, page, limit },
  }).send(res);
};

//delete Post
export const deletePost = async (req, res) => {
  const postId = req.params.id;
  const userId = String(req.user._id);
  const post = await Post.findById(postId);
  if (!post) {
    throw new NotFoundError("Post not found");
  }
  if (post.authorId.toString() !== userId) {
    throw new AuthFailureError("Unauthorized to delete post");
  }
  await Post.updateMany(
    { parentPost: postId, type: PostConstants.ACTIONS.REPLY },
    {
      status: Constants.POST_STATUS.DELETED,
    },
  );
  if (post.parentPost && post.type === PostConstants.ACTIONS.REPLY) {
    await Post.updateOne(
      { _id: post.parentPost },
      { $inc: { repliesCount: -1, engagementScore: -3 } },
    );
  }
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
  const postId = req.params.id;
  const { media, content, survey, visibility, files } = payload;
  let post = await Post.findById(postId);
  if (!post) {
    throw new NotFoundError("Post not found");
  }

  if (post.authorId.toString() !== String(req.user._id)) {
    throw new AuthFailureError("Unauthorized to update this post");
  }
  let newSurvey = [];
  if (survey?.length) {
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
  if (media !== undefined) {
    const existingUrls = new Set((post.media || []).map((m: any) => m?.url));
    const processedMedia = [];
    for (const item of media) {
      if (existingUrls.has(item.url)) {
        processedMedia.push(item);
        continue;
      }
      const processed = await processNewPostMediaItem(
        item,
        post.authorId.toString(),
      );
      if (!processed) {
        throw new BadRequestError(`Invalid media URL: ${item.url}`);
      }
      processedMedia.push(processed);
    }
    post.media = processedMedia;
  }
  if (visibility !== undefined) {
    post.visibility = visibility;
  }
  if (files !== undefined) {
    post.files = files;
  }
  post.content = content;
  if (survey !== undefined) {
    post.survey = newSurvey;
  }
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
    throw new NotFoundError("Post not found");
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
  const isAdminPage = pageFilter?.includes("admin");
  if (isAdminPage) {
    payload.isAdminPage = true;
  }
  if (isAdminPage) {
    const viewer = await User.findById(req.viewerId);
    const allowedRoles = [
      Constants.USER_ROLE.ADMIN,
      Constants.USER_ROLE.MODERATOR,
    ];
    if (!viewer || !allowedRoles.includes(viewer.role)) {
      throw new AuthFailureError("Admin/Moderator only");
    }
  }
  payload.viewerId = req.viewerId ?? null;
  const data = await getPostsIdByFilter(payload);
  let result = [];
  if (data?.length) {
    result = await getPostDetail({
      postIds: data,
      viewerId: payload.viewerId,
      isAdminPage: !!isAdminPage,
      followeeIds: payload.followeeIds ?? null,
    });
  }
  const metadata =
    isAdminPage && payload.totalCount !== undefined
      ? { data: result, totalCount: payload.totalCount }
      : result;
  new OK({
    message: "Get posts successfully",
    metadata,
  }).send(res);
};

export const getSitemapEligiblePosts = async (req, res) => {
  const { cursor, limit } = req.query as { cursor?: string; limit: number };
  const [cursorScore, cursorId] = cursor
    ? cursor.split(":")
    : [undefined, undefined];

  const baseFilter = {
    status: Constants.POST_STATUS.PUBLIC,
    visibility: Constants.POST_VISIBILITY.PUBLIC,
    engagementScore: { $gte: 5 },
  };
  const findFilter = cursor
    ? {
        ...baseFilter,
        $or: [
          { engagementScore: { $lt: Number(cursorScore) } },
          { engagementScore: Number(cursorScore), _id: { $lt: cursorId } },
        ],
      }
    : baseFilter;

  const posts = await Post.find(findFilter)
    .sort({ engagementScore: -1, _id: -1 })
    .limit(limit)
    .select("_id updatedAt engagementScore")
    .lean();

  const totalCount = cursor
    ? null
    : Math.min(await Post.countDocuments(baseFilter), SITEMAP_MAX_RECORDS);

  const data = posts.map((post: any) => ({
    postId: post._id.toString(),
    updatedAt: post.updatedAt,
    engagementScore: post.engagementScore,
  }));
  const nextCursor =
    posts.length === limit
      ? `${data[data.length - 1].engagementScore}:${data[data.length - 1].postId}`
      : null;

  new OK({
    message: "Get sitemap-eligible posts successfully",
    metadata: { data, nextCursor, totalCount },
  }).send(res);
};

export const tickPostSurvey = async (req, res) => {
  const { optionId, isAdd } = req.body;
  const userId = ObjectId(String(req.user._id));
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
  const { status } = req.body;
  const { id: postId } = req.params;
  if (!postId) {
    throw new BadRequestError("Empty payload");
  }
  assertRole(
    req.user,
    Constants.USER_ROLE.ADMIN,
    Constants.USER_ROLE.MODERATOR,
  );
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

export const updatePostVisibility = async (req, res) => {
  const { visibility } = req.body;
  const { id: postId } = req.params;
  if (!postId) {
    throw new BadRequestError("Empty payload");
  }
  const validVisibilityValues: number[] = Object.values(
    Constants.POST_VISIBILITY,
  );
  if (!validVisibilityValues.includes(visibility)) {
    throw new BadRequestError("Invalid visibility value");
  }
  const post = await Post.findById(postId, { authorId: 1 });
  if (!post) {
    throw new NotFoundError("Post not found");
  }
  const isOwner = post.authorId.toString() === String(req.user._id);
  const isModerator = [
    Constants.USER_ROLE.ADMIN,
    Constants.USER_ROLE.MODERATOR,
  ].includes(req.user?.role);
  if (!isOwner && !isModerator) {
    throw new ForbiddenError(
      "Chỉ tác giả hoặc quản trị viên mới đổi được quyền riêng tư",
    );
  }
  await Post.updateOne(
    {
      _id: ObjectId(postId),
    },
    {
      visibility: visibility,
    },
  );
  new OK({
    message: "OK",
    metadata: {},
  }).send(res);
};

export const getPostActivities = async (req, res) => {
  const { id: postId } = req.params;
  const type = req.query.type || "likes";
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const skip = (page - 1) * limit;

  const post = await Post.findById(postId);
  if (!post) {
    throw new NotFoundError("Post not found");
  }

  let users: any[] = [];
  let total = 0;

  if (type === "likes") {
    total = await Like.countDocuments({ postId: ObjectId(postId) });
    const likes = await Like.find({ postId: ObjectId(postId) })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("userId", "_id username name avatar bio followersCount");
    users = likes.map((l: any) => l.userId).filter(Boolean);
  } else if (type === "comments") {
    const filterQuery = {
      parentPost: ObjectId(postId),
      status: { $ne: Constants.POST_STATUS.DELETED },
    };
    total = await Post.countDocuments(filterQuery);
    const commentPosts = await Post.find(filterQuery)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("authorId", "_id username name avatar bio followersCount");

    users = commentPosts
      .map((c: any) => ({
        ...((c.authorId as any)?.toObject?.() || c.authorId),
        commentContent: c.content,
        commentCreatedAt: c.createdAt,
      }))
      .filter((u) => u && u._id);
  } else if (type === "reposts") {
    const filterQuery = {
      $or: [
        { "quote._id": ObjectId(postId) },
        { "quote._id": String(postId) },
        { parentPost: ObjectId(postId), type: PostConstants.ACTIONS.REPOST },
      ],
      status: { $ne: Constants.POST_STATUS.DELETED },
    };
    total = await Post.countDocuments(filterQuery);
    const repostPosts = await Post.find(filterQuery)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("authorId", "_id username name avatar bio followersCount");

    users = repostPosts
      .map((r: any) => (r.authorId as any)?.toObject?.() || r.authorId)
      .filter((u) => u && u._id);
  }

  if (req.viewerId && users.length > 0) {
    const userIds = users.map((u) => ObjectId(u._id));
    const followingDocs = await Follow.find({
      followerId: ObjectId(req.viewerId),
      followeeId: { $in: userIds },
    });
    const followingSet = new Set(
      followingDocs.map((f: any) => f.followeeId.toString()),
    );
    users = users.map((u) => ({
      ...(typeof u.toObject === "function" ? u.toObject() : u),
      isFollowing: followingSet.has(u._id.toString()),
      isSelf: req.viewerId.toString() === u._id.toString(),
    }));
  }

  new OK({
    message: "Get post activities successfully",
    metadata: {
      type,
      total,
      page,
      limit,
      users,
    },
  }).send(res);
};
