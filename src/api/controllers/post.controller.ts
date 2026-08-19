import axios from "axios";
import { Constants } from "../../Breads-Shared/Constants/index.js";
import PostConstants from "../../Breads-Shared/Constants/PostConstants.js";
import { IPost } from "../../Breads-Shared/Types/index.js";
import { CREATED, OK } from "../../core/success.response.js";
import {
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
  getPostDetail,
  getPostsIdByFilter,
  handleReplyForParentPost,
} from "../services/post.js";
import { uploadFileFromBase64 } from "../utils/index.js";
import { validateMediaUrl } from "../validators/validateMediaUrl.ts";

/**
 * FR-10 / Task 090 fix: một payload "giống repost" (copy nội dung bài khác vào `quote.content`)
 * kích hoạt guard theo CẢ 3 tín hiệu độc lập — thiếu bất kỳ tín hiệu nào cũng để lọt bypass đã
 * từng xảy ra thật (xem GAP-2, epic post-visibility verify report):
 *   - `action=repost` (query param, Fe gửi khi user bấm nút Repost)
 *   - `type=REPOST` (payload field — client tự gọi API có thể gửi field này mà bỏ action)
 *   - `quote?._id` được set thủ công (client tự dựng payload `type=CREATE` + `quote`, không qua
 *     `parentPost`/action nào cả — đây chính là bypass đã bị khai thác live trong task 090)
 * Hàm thuần, không chạm DB — export để unit test riêng, KHÔNG phụ thuộc `createPost`.
 */
export const isRepostLikePayload = (payload: {
  action?: string;
  type?: string;
  quote?: { _id?: any };
}): boolean =>
  payload.action === PostConstants.ACTIONS.REPOST ||
  payload.type === PostConstants.ACTIONS.REPOST ||
  !!payload.quote?._id;

/**
 * FR-10: bài được repost/quote phải tồn tại VÀ có `visibility=PUBLIC` — nếu không, nội dung
 * riêng tư của bài gốc sẽ bị nhân bản nguyên văn vào `quote.content` của bài mới, ra ngoài mọi
 * ràng buộc visibility (010). Nhận thẳng document đã fetch (hoặc `null`) — hàm thuần, không tự
 * query DB — để unit test được mà không cần Mongo.
 */
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

/**
 * FR-2/FR-6/FR-7/FR-8 (Task 012): nhánh rẽ fan-out-on-write theo `FEED_CONFIG.fanoutMode`.
 * `"direct"` gọi `fanoutPostToFollowers` y hệt hành vi cũ 100% — đường rollback duy nhất (US-5)
 * nếu BullMQ có vấn đề sau khi ship. `"queue"` (mặc định), guard bởi `FEED_CONFIG.fanoutEnabled`
 * (kill-switch cũ), enqueue job `fanout-post` vào `dispatchQueue` với `jobId = postId` (chống
 * enqueue trùng). Lỗi enqueue bị `catch` tại chỗ (NFR-2) — không được làm `createPost` trả 5xx.
 *
 * `deps` tiêm được (cùng pattern `processDispatchJob`/`fanout.dispatch.test.ts` trong epic này) để
 * test độc lập cả 4 nhánh mà không cần Mongo/Redis thật — mặc định luôn là hàm/instance thật, nên
 * hành vi production không đổi khi gọi không truyền `deps`.
 */
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

/**
 * Task 011 (FR-5, epic `presigned-media-upload`): 3-bước check dùng chung cho 1 item media MỚI
 * (không phải toàn bộ batch) — ĐÚNG THỨ TỰ như task 010's `sendMessage` (xem `epic.md` AD-4/AD-5):
 *   (1) `type === GIF` -> bỏ qua validate (carve-out cấp item, post CÓ data GIF thật -
 *       `crawl.ts:54-84`).
 *   (2) Else nếu flag break-glass bật VÀ `url` là `data:` URI -> fallback `uploadFileFromBase64`
 *       cũ (giữ ở trạng thái ngủ, AD-5). Thứ tự (2) trước (3) là bắt buộc, nếu không flag thành
 *       dead code (AD5-1).
 *   (3) Else -> `validateMediaUrl` strict theo `namespace: "post"` + `expectedKey: authorId`.
 * Trả về item đã xử lý (có thể đổi `url` nếu qua fallback base64) nếu hợp lệ, `null` nếu bị reject.
 * Dùng bởi CẢ `createPost` (mọi item) LẪN `updatePost` (chỉ item MỚI, sau khi đã diff) — nhưng
 * control-flow bao quanh (validate toàn bộ vs. diff-rồi-validate-phần-mới) vẫn tách riêng ở 2 hàm,
 * không dùng chung 1 helper gọi giống nhau (đúng Key risk của epic T4).
 */
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
  if (!validateMediaUrl(item.url, { namespace: "post", expectedKey: authorId })) {
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
    throw new NotFoundError("User not found");
  }
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
    throw new BadRequestError(
      `Text must be less than ${maxLength} characters`,
    );
  }
  // [plan-review] `visibility` do client gửi lên phải nằm trong enum — chặn ở đây thay vì để
  // Mongoose enum ném ValidationError 500 lúc `.save()`.
  const validVisibilityValues: number[] = Object.values(
    Constants.POST_VISIBILITY,
  );
  if (
    payload.visibility !== undefined &&
    !validVisibilityValues.includes(payload.visibility)
  ) {
    throw new BadRequestError("Invalid visibility value");
  }
  // Task 011: media hoàn toàn mới ở `createPost` -> MỌI item đều qua 3-bước check
  // (`processNewPostMediaItem`), thay cho `uploadFileFromBase64` relay bytes trực tiếp cũ.
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
  // Chặn theo CẢ `action` (query param) lẫn `type` (payload): client tự gọi API có thể gửi
  // `type=REPOST` mà bỏ `?action=repost`, vẫn kèm `quote.content` copy từ bài gốc.
  // Task 090 fix: cũng chặn khi `quote?._id` được set mà KHÔNG đi kèm `type/action=REPOST`
  // (ví dụ `type=CREATE` + tự set `quote: { _id, content }` thủ công, không có `parentPost`) —
  // đây vẫn đúng vector rò rỉ FR-10 mô tả (nhân bản nội dung bài non-PUBLIC ra một bài không bị
  // ràng buộc visibility gì), chỉ khác field kích hoạt so với nhánh REPOST thông thường.
  if (isRepostLikePayload({ action, type, quote })) {
    // FR-10: repost copy nguyên văn nội dung bài gốc sang bài mới, nên cho repost bài non-PUBLIC
    // là nhân bản nội dung riêng tư ra ngoài vòng kiểm soát visibility (010). Phải chặn ở Be —
    // ẩn nút phía Fe không đủ, mọi client/API call trực tiếp đều bypass được UI.
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
  const newPost = new Post(newPostPayload);
  const postSaved = await newPost.save();
  // Fan-out-on-write (FR-5). KHÔNG `await`: NFR-2 cấm fan-out chặn response — một tác giả gần
  // ngưỡng celebrity (hoặc một job enqueue chậm) sẽ làm response treo hàng giây. `.catch()` là bắt
  // buộc: rejection không bắt chỉ rơi vào handler `unhandledRejection` toàn cục (001), mất hết
  // ngữ cảnh. Task 012: nhánh direct/queue theo `FEED_CONFIG.fanoutMode` — xem `dispatchFanout`.
  dispatchFanout(postSaved, req.app.get("socket_io"));
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
    throw new NotFoundError("Post not found!");
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
    throw new BadRequestError("Empty payload");
  }
  const post = await Post.findById(postId);
  if (!post) {
    throw new NotFoundError("Post not found");
  }
  if (post.authorId.toString() !== userId.toString()) {
    throw new AuthFailureError("Unauthorized to delete post");
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
  // Task 011 (D-1/FR-3): route đổi `PUT /posts/update` -> `PUT /posts/:id`, nên id bài viết lấy từ
  // path param thay vì `payload._id` do client gửi trong body.
  const postId = req.params.id;
  const { media, content, survey, visibility, files } = payload;
  let post = await Post.findById(postId);
  if (!post) {
    throw new NotFoundError("Post not found");
  }

  if (post.authorId.toString() !== payload.userId.toString()) {
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
  // Task 011 (FR-5): `updatePost` trước đây KHÔNG validate `media` gì cả (`post.media = media;` vô
  // điều kiện) — đây là thêm MỚI, không phải sửa/xoá 1 cơ chế cũ. Diff `media` (payload client gửi)
  // với `post.media` HIỆN TẠI (đã fetch sẵn ở trên, dòng ~366 - không query lại DB): item nào đã có
  // trong `post.media` cũ (khớp theo `url`) giữ nguyên, KHÔNG validate lại (tin dữ liệu đã lưu -
  // media từ TRƯỚC epic này vẫn sửa post được bình thường). Item MỚI (chưa có trong `post.media`
  // cũ) mới qua `processNewPostMediaItem` (cùng 3-bước check như `createPost`).
  // `media === undefined` (client không gửi field này, vd. chỉ update `survey`) -> không đụng
  // `post.media`, giữ nguyên giá trị hiện có.
  if (media !== undefined) {
    const existingUrls = new Set(
      (post.media || []).map((m: any) => m?.url),
    );
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
  // [010] Danh tính người xem chỉ lấy từ jwt (`optionalAuth`), luôn ghi đè giá trị client gửi lên:
  // `userId` trong query là "feed/trang cá nhân của AI", không phải "AI đang hỏi" (NFR-2).
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
  new OK({
    message: "Get posts successfully",
    metadata: result,
  }).send(res);
};

export const tickPostSurvey = async (req, res) => {
  const { optionId, userId, isAdd } = req.body;
  if (!optionId || !userId) {
    throw new BadRequestError("Empty payload");
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
    throw new BadRequestError("Empty payload");
  }
  const userInfo = await User.findOne({
    _id: ObjectId(userId),
  });
  const isAdmin = userInfo?.role === Constants.USER_ROLE.ADMIN;
  if (!isAdmin) {
    throw new AuthFailureError("Only for admin");
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

// FR-3: đổi visibility sau khi đăng. Mirror `updatePostStatus` (cùng verb/shape) nhưng KHÔNG
// đụng tới field `status` — hai field độc lập (SC-8). Quyền: tác giả bài viết, không phải admin.
export const updatePostVisibility = async (req, res) => {
  const { userId, postId, visibility } = req.body;
  if (!userId || !postId) {
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
  if (post.authorId.toString() !== userId.toString()) {
    throw new AuthFailureError("Unauthorized to update this post");
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
      $or: [
        { parentPost: ObjectId(postId) },
        { _id: { $in: post.replies || [] } },
      ],
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
        { parentPost: ObjectId(postId), type: Constants.POST_TYPE.REPOST },
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
      .map((r: any) => ((r.authorId as any)?.toObject?.() || r.authorId))
      .filter((u) => u && u._id);
  }

  if (req.viewerId && users.length > 0) {
    const userIds = users.map((u) => ObjectId(u._id));
    const followingDocs = await Follow.find({
      followerId: ObjectId(req.viewerId),
      followeeId: { $in: userIds },
    });
    const followingSet = new Set(
      followingDocs.map((f: any) => f.followeeId.toString())
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

