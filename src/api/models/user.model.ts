import mongoose from "mongoose";
import { Constants } from "../../Breads-Shared/Constants/index.js";

const ObjectId = mongoose.Schema.Types.ObjectId;
const userStatus = Object.values(Constants.USER_STATUS);

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    username: {
      type: String,
      required: true,
      unique: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
    },
    password: {
      type: String,
      minLength: 6,
      required: true,
    },
    avatar: {
      type: String,
      default:
        "https://as2.ftcdn.net/v2/jpg/04/10/43/77/1000_F_410437733_hdq4Q3QOH9uwh0mcqAhRFzOKfrCR24Ta.jpg",
    },
    bio: {
      type: String,
      default: "",
    },
    role: {
      type: Number,
      default: 1,
    },
    links: [
      {
        type: String,
        required: false,
      },
    ],
    hasNewNotify: {
      type: Boolean,
      default: false,
    },
    hasNewMsg: {
      type: Boolean,
      default: false,
    },
    resetPWCode: {
      type: String,
      required: false,
    },
    status: {
      type: Number,
      enum: userStatus,
      default: Constants.USER_STATUS.ACTIVE,
    },
    catesCare: [
      {
        type: ObjectId,
        ref: "Categories",
        required: false,
      },
    ],
    followersCount: {
      type: Number,
      default: 0,
    },
    followingCount: {
      type: Number,
      default: 0,
    },
    lastActiveAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

const User = mongoose.model("User", userSchema);

export default User;
