import mongoose from "mongoose";
import PostConstants from "../../Breads-Shared/Constants/PostConstants";
import { Constants } from "../../Breads-Shared/Constants";

const { CREATE, EDIT, REPOST } = PostConstants.ACTIONS;
const ObjectId = mongoose.Schema.Types.ObjectId;

const postStatus = Object.values(Constants.POST_STATUS);
const postVisibility = Object.values(Constants.POST_VISIBILITY);

const postSchema = new mongoose.Schema(
  {
    authorId: {
      type: ObjectId,
      ref: "User",
      required: true,
    },
    content: {
      type: String,
      maxLength: 500,
    },
    media: {
      type: Array,
      required: false,
    },
    replies: [
      {
        type: ObjectId,
        ref: "Post",
        default: [],
      },
    ],
    parentPost: {
      type: ObjectId,
      ref: "Post",
      required: false,
    },
    survey: [
      {
        type: ObjectId,
        ref: "SurveyOption",
        required: false,
      },
    ],
    type: {
      type: String,
      default: "create",
      required: true,
    },
    quote: {
      type: Object,
      required: false,
    },
    usersTag: [
      {
        type: ObjectId,
        ref: "User",
        required: false,
      },
    ],
    links: [
      {
        type: ObjectId,
        ref: "Link",
        required: false,
      },
    ],
    files: [
      {
        type: ObjectId,
        ref: "File",
        required: false,
      },
    ],
    status: {
      type: Number,
      enum: postStatus,
      default: Constants.POST_STATUS.PRE_ACCEPT,
    },
    visibility: {
      type: Number,
      enum: postVisibility,
      default: Constants.POST_VISIBILITY.PUBLIC,
    },
    categories: [
      {
        type: ObjectId,
        ref: "Categories",
        required: false,
      },
    ],
    likesCount: {
      type: Number,
      default: 0,
    },
    engagementScore: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  },
);

postSchema.index({ createdAt: -1 });
postSchema.index(
  { parentPost: 1 },
  {
    sparse: true,
  },
);
postSchema.index(
  {
    type: 1,
    authorId: 1,
    createdAt: -1,
  },
  {
    partialFilterExpression: {
      type: {
        $in: [CREATE, EDIT, REPOST],
      },
    },
  },
);
postSchema.index(
  { type: 1, createdAt: -1 },
  { partialFilterExpression: { type: { $in: [CREATE, EDIT, REPOST] } } },
);
postSchema.index({ engagementScore: -1, _id: -1 });
// USER/FRIEND page (post.ts getPostsIdByFilter): lọc authorId + sort createdAt, với `type`
// $nin (mặc định) hoặc = "reply" — cả hai đều không khớp partialFilterExpression của
// `type_1_authorId_1_createdAt_-1` (chỉ CREATE/EDIT/REPOST) nên trước đây Mongo fallback về
// scan toàn bộ index `createdAt_-1` (~6M doc mới trả 9 kết quả, ~20s). Index này không có
// partial filter nên áp dụng được với mọi giá trị `type`.
postSchema.index({ authorId: 1, createdAt: -1 });

const Post = mongoose.model("Post", postSchema);

export default Post;
