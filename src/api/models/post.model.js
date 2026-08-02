import mongoose from "mongoose";
import PostConstants from "../../Breads-Shared/Constants/PostConstants";
import { Constants } from "../../Breads-Shared/Constants";

const { CREATE, EDIT, REPOST } = PostConstants.ACTIONS;
const ObjectId = mongoose.Schema.Types.ObjectId;

const postStatus = Object.values(Constants.POST_STATUS);

const postSchema = mongoose.Schema(
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
      default: Constants.POST_STATUS.PENDING,
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
  },
  {
    timestamps: true,
  },
);

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

const Post = mongoose.model("Post", postSchema);

export default Post;
