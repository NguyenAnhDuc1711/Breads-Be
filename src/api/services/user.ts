import { randomBytes } from "node:crypto";
import { ObjectId } from "../../utils/index.js";
import logger from "../../core/logger.js";
import Follow from "../models/follow.model.js";
import SavedPost from "../models/savedPost.model.js";
import User from "../models/user.model.js";
import {
  backfillFeedOnFollow,
  removeFeedOnUnfollow,
} from "./feed/fanout.ts";

const FOLLOW_RELATIONS_LIMIT = 5000;

export const followRelationsLookupStages = (localField = "_id") => [
  {
    $lookup: {
      from: "follows",
      localField,
      foreignField: "followeeId",
      pipeline: [
        { $limit: FOLLOW_RELATIONS_LIMIT },
        { $project: { _id: 0, followerId: 1 } },
      ],
      as: "followedByDocs",
    },
  },
  {
    $lookup: {
      from: "follows",
      localField,
      foreignField: "followerId",
      pipeline: [
        { $limit: FOLLOW_RELATIONS_LIMIT },
        { $project: { _id: 0, followeeId: 1 } },
      ],
      as: "followingDocs",
    },
  },
  {
    $addFields: {
      followed: "$followedByDocs.followerId",
      following: "$followingDocs.followeeId",
    },
  },
];

export const getUserInfo = async (userId, { includeRelations = true } = {}) => {
  try {
    if (!userId) {
      return null;
    }
    const result = await User.aggregate([
      { $match: { _id: ObjectId(userId) } },
      ...(includeRelations ? followRelationsLookupStages() : []),
      {
        $project: {
          password: 0,
          updatedAt: 0,
          followedByDocs: 0,
          followingDocs: 0,
        },
      },
    ]);
    const user = result?.[0];
    if (!user) {
      return null;
    }
    const savedPosts = await SavedPost.find(
      { userId: ObjectId(userId) },
      { postId: 1 }
    ).sort({ createdAt: -1 });
    user.collection = savedPosts.map(({ postId }) => postId);
    return user;
  } catch (err) {
    logger.error({ err }, "getUserInfo failed");
  }
};

export const toggleFollow = async (followerId, followeeId) => {
  const existing = await Follow.findOne({
    followerId: ObjectId(followerId),
    followeeId: ObjectId(followeeId),
  });
  if (existing) {
    await Follow.deleteOne({ _id: existing._id });
    await User.updateOne(
      { _id: ObjectId(followerId) },
      { $inc: { followingCount: -1 } }
    );
    await User.updateOne(
      { _id: ObjectId(followeeId) },
      { $inc: { followersCount: -1 } }
    );
    removeFeedOnUnfollow(followerId, followeeId).catch((err) =>
      logger.error({ err }, "[toggleFollow] removeFeedOnUnfollow failed")
    );
    return false;
  }
  await Follow.create({
    followerId: ObjectId(followerId),
    followeeId: ObjectId(followeeId),
  });
  await User.updateOne(
    { _id: ObjectId(followerId) },
    { $inc: { followingCount: 1 } }
  );
  await User.updateOne(
    { _id: ObjectId(followeeId) },
    { $inc: { followersCount: 1 } }
  );
  backfillFeedOnFollow(followerId, followeeId).catch((err) =>
    logger.error({ err }, "[toggleFollow] backfillFeedOnFollow failed")
  );
  return true;
};

// --- Sinh username tự động từ email Google (không có username trong id_token) ---

const USERNAME_MIN_LENGTH = 3;
const USERNAME_MAX_LENGTH = 30;
const USERNAME_CHARSET_REGEX = /[^a-z0-9._-]/g;
const USERNAME_RETRY_LIMIT = 5;

/**
 * Sinh username ứng viên từ phần trước "@" của email.
 * Thứ tự làm sạch: hạ chữ thường -> loại (không thay thế) ký tự ngoài [a-z0-9._-] -> cắt 30 ký tự.
 * Nếu kết quả rỗng hoặc < 3 ký tự, dùng "user" + hậu tố ngẫu nhiên (luôn thoả độ dài tối thiểu).
 */
export const generateUsernameFromEmail = (email) => {
  const localPart = String(email ?? "").split("@")[0] ?? "";
  const cleaned = localPart
    .toLowerCase()
    .replace(USERNAME_CHARSET_REGEX, "")
    .slice(0, USERNAME_MAX_LENGTH);

  if (cleaned.length < USERNAME_MIN_LENGTH) {
    return `user${randomBytes(3).toString("hex")}`;
  }
  return cleaned;
};

/**
 * Ứng viên username cho lần thử thứ `attempt`. attempt 0 -> username gốc,
 * attempt n > 0 -> `${base}${n}`, cắt bớt phần gốc nếu cần để tổng không vượt 30 ký tự.
 */
export const usernameCandidateAt = (baseUsername, attempt) => {
  if (attempt <= 0) {
    return baseUsername;
  }
  const suffix = String(attempt);
  const maxBaseLength = USERNAME_MAX_LENGTH - suffix.length;
  return `${baseUsername.slice(0, maxBaseLength)}${suffix}`;
};

const isUsernameDuplicateKeyError = (err) => {
  if (!err || err.code !== 11000) {
    return false;
  }
  if (err.keyPattern && Object.prototype.hasOwnProperty.call(err.keyPattern, "username")) {
    return true;
  }
  if (err.keyValue && Object.prototype.hasOwnProperty.call(err.keyValue, "username")) {
    return true;
  }
  return false;
};

/**
 * Thực hiện `performWrite(candidateUsername)`; nếu ghi thất bại do E11000 trên trường
 * `username`, sinh ứng viên tiếp theo và thử lại (tối đa `maxAttempts` lần). E11000 trên
 * trường khác (vd. `email`) hoặc bất kỳ lỗi nào khác được ném ra nguyên vẹn, không retry.
 * Không dùng kiểu "kiểm rồi ghi" — race được xử lý bằng cách bắt lỗi ngay từ thao tác ghi.
 */
export const writeWithUsernameRetry = async (
  baseUsername,
  performWrite,
  maxAttempts = USERNAME_RETRY_LIMIT
) => {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidateUsername = usernameCandidateAt(baseUsername, attempt);
    try {
      return await performWrite(candidateUsername);
    } catch (err) {
      if (!isUsernameDuplicateKeyError(err)) {
        throw err;
      }
      lastErr = err;
    }
  }
  throw new Error(
    `writeWithUsernameRetry: hết ${maxAttempts} lần thử vẫn đụng username trùng (base="${baseUsername}")`,
    { cause: lastErr }
  );
};

export const getUsersByPage = async ({ page, limit, agg }) => {
  try {
    const skip = Number((page - 1) * limit);
    const data = await User.aggregate([
      ...agg,
      {
        $project: {
          _id: 1,
          avatar: 1,
          username: 1,
          name: 1,
          bio: 1,
          followed: 1,
          status: 1,
          role: 1,
          createdAt: 1,
          lastActiveAt: 1,
          email: 1,
        },
      },
      { $skip: skip },
      {
        $limit: Number(limit),
      },
    ]);
    return data;
  } catch (err) {
    logger.error({ err }, "getUsersByPage failed");
    return [];
  }
};
