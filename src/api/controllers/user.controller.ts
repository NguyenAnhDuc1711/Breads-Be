import { Constants } from "../../Breads-Shared/Constants/index.js";
import { IUser } from "../../Breads-Shared/Types/index.js";
import { genRandomCode } from "../../Breads-Shared/util/index.js";
import {
  AuthFailureError,
  BadRequestError,
  NotFoundError,
} from "../../core/error.response.js";
import { CREATED, OK } from "../../core/success.response.js";
import { deleteCache, getCache, setCache } from "../../dbs/redis.ts";
import { ObjectId } from "../../utils/index.js";
import { crawlUser } from "../crawl.js";
import Follow from "../models/follow.model.js";
import Post from "../models/post.model.js";
import SavedPost from "../models/savedPost.model.js";
import User from "../models/user.model.js";
import { getUserInfo, getUsersByPage, toggleFollow } from "../services/user.js";
import { sendMailService } from "../services/util.js";
import generateTokens, {
  clearRefreshTokenCookie,
  generateAccessToken,
  hashToken,
} from "../utils/generateTokens.js";
import RefreshToken from "../models/refreshToken.model.js";
import TokenBlacklist from "../models/tokenBlacklist.model.js";
import logger from "../../core/logger.js";
import bcrypt from "bcryptjs";
import { uploadFileFromBase64, validateEmailForm } from "../utils/index.js";

export const getAdminAccount = async (req, res) => {
  let adminAccount = await User.findOne({
    role: Constants.USER_ROLE.ADMIN,
  });
  if (!adminAccount) {
    const newAdmin = new User({
      email: "admin@gmail.com",
      name: "Admin",
      username: "Admin",
      password: "123456",
      role: Constants.USER_ROLE.ADMIN,
    });
    const result = await newAdmin.save();
    return new CREATED({
      message: "Admin account created successfully",
      metadata: result,
    }).send(res);
  }
  const savedPosts = await SavedPost.find(
    { userId: adminAccount._id },
    { postId: 1 },
  ).sort({ createdAt: -1 });
  adminAccount.collection = {
    userId: adminAccount._id,
    postsId: savedPosts.map(({ postId }) => postId),
  };
  new OK({
    message: "Admin account fetched successfully",
    metadata: adminAccount,
  }).send(res);
};

//sign up
export const signupUser = async (req, res) => {
  const { name, email, username, password } = req.body;
  const userEmail = await User.findOne({ email });
  const userUsername = await User.findOne({ username });
  if (userUsername?._id) {
    throw new BadRequestError("Username already exists");
  }
  if (userEmail?._id) {
    throw new BadRequestError("Email already exists");
  }

  const expireTime = 10; // Minutes
  const code = genRandomCode();
  const result = await sendMailService({
    from: "mraducky@gmail.com",
    to: email,
    subject: "Validation for creating Breads account",
    html: validateEmailForm(code, expireTime),
  });

  if (result) {
    const keyCache = `mail_validation_${email}`;
    await setCache(
      keyCache,
      JSON.stringify({ name, email, username, password, code }),
      expireTime * 60,
    );
    new OK({
      message: "Mail was sent",
      metadata: {},
    }).send(res);
  }
};

export const validateEmailByCode = async (req, res) => {
  const { email, code } = req.body;
  const keyCache = `mail_validation_${email}`;
  const validationMailInfo = JSON.parse(await getCache(keyCache));
  if (validationMailInfo) {
    if (code === validationMailInfo?.code) {
      const { name, username, password } = validationMailInfo;
      const hashedPassword = await bcrypt.hash(password, 10);
      const newUser = new User({
        name,
        email,
        username,
        password: hashedPassword,
      });
      await newUser.save();

      if (newUser) {
        // generateTokenAndSetCookie(newUser._id, res);
        await deleteCache(keyCache);
        new CREATED({
          message: "Create new user successfully",
          metadata: {},
        }).send(res);
      } else {
        throw new BadRequestError("Create new user failed");
      }
    } else {
      throw new BadRequestError("Incorrect code");
    }
  } else {
    throw new BadRequestError("Validation code has been expired");
  }
};

//login
export const loginUser = async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email: email });

  if (!user) {
    throw new BadRequestError("Account not found");
  }

  let isPasswordCorrect = false;
  if (user.password) {
    if (user.password.startsWith("$2a$") || user.password.startsWith("$2b$")) {
      isPasswordCorrect = await bcrypt.compare(password, user.password);
    } else {
      // Legacy plain-text password fallback and auto-upgrade
      if (password === user.password) {
        isPasswordCorrect = true;
        const hashedPassword = await bcrypt.hash(password, 10);
        await User.updateOne({ _id: user._id }, { password: hashedPassword });
      }
    }
  }

  if (!isPasswordCorrect) {
    throw new AuthFailureError("Wrong password");
  }

  const result = await getUserInfo(user._id);
  const { accessToken } = await generateTokens(user._id.toString(), res);

  new OK({
    message: "Login successfully",
    metadata: { ...result, accessToken },
  }).send(res);
};

// logout
export const logoutUser = async (req, res) => {
  const rawRefreshToken = req.cookies?.refreshToken;
  if (rawRefreshToken) {
    const hashedToken = hashToken(rawRefreshToken);
    await RefreshToken.deleteOne({ token: hashedToken });
  }
  clearRefreshTokenCookie(res);
  new OK({
    message: "User log out successfully",
    metadata: {},
  }).send(res);
};

// refresh token with rotation + reuse detection
export const refreshTokenHandler = async (req, res) => {
  const rawRefreshToken = req.cookies?.refreshToken;
  if (!rawRefreshToken) {
    throw new AuthFailureError("No refresh token provided");
  }

  const hashedToken = hashToken(rawRefreshToken);
  const storedToken = await RefreshToken.findOne({ token: hashedToken });

  if (!storedToken) {
    // Token reuse detection: this token was already consumed by rotation
    // or was never valid. Possible token theft — revoke ALL refresh tokens
    // for the user who originally owned this token and blacklist them.
    //
    // Try to decode the refresh token to identify the user — but since
    // refresh tokens are opaque (not JWT), we can't extract userId from
    // the token itself. Instead, log the incident and return 401.
    logger.warn(
      { hashedToken: hashedToken.substring(0, 16) + "..." },
      "Refresh token reuse detected — possible token theft",
    );

    // We cannot determine the userId from an opaque token that's not in DB,
    // but if the request has a valid (expired) access token we can try to
    // extract the userId from it to revoke all their sessions.
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      try {
        const jwt = await import("jsonwebtoken");
        const decoded: any = jwt.default.decode(
          authHeader.split(" ")[1],
        );
        if (decoded?.userId) {
          // Force revoke ALL refresh tokens for this user
          await RefreshToken.deleteMany({ userId: decoded.userId });
          // Record in blacklist
          await TokenBlacklist.create({
            userId: decoded.userId,
            reason: "TOKEN_REUSE",
            metadata: {
              detectedAt: new Date(),
              tokenPrefix: hashedToken.substring(0, 16),
            },
          });
          logger.warn(
            { userId: decoded.userId },
            "All refresh tokens revoked due to token reuse — user blacklisted",
          );
        }
      } catch {
        // Can't decode — just return 401
      }
    }

    clearRefreshTokenCookie(res);
    throw new AuthFailureError("Invalid refresh token");
  }

  // Check if token has expired (belt-and-suspenders; TTL index handles cleanup)
  if (storedToken.expiresAt < new Date()) {
    await RefreshToken.deleteOne({ _id: storedToken._id });
    clearRefreshTokenCookie(res);
    throw new AuthFailureError("Refresh token expired");
  }

  // Rotation: delete the old refresh token BEFORE issuing a new one
  await RefreshToken.deleteOne({ _id: storedToken._id });

  // Issue new token pair
  const userId = storedToken.userId.toString();
  const { accessToken } = await generateTokens(userId, res);

  new OK({
    message: "Token refreshed successfully",
    metadata: { accessToken },
  }).send(res);
};

//follow and unfollow
export const followUser = async (req, res) => {
  const { userFlId, userId } = req.body;
  if (!userFlId || !userId) {
    throw new BadRequestError("Empty payload");
  }
  const userInfo = await User.findOne({ _id: ObjectId(userId) });
  if (!userInfo) {
    throw new NotFoundError("User not found");
  }
  await toggleFollow(userId, userFlId);
  new OK({
    message: "Follow user successfully",
    metadata: {},
  }).send(res);
};

// update
export const updateUser = async (req, res) => {
  const payload = req.body;
  const userId = req.params.id;

  let user = await User.findById(userId);
  if (!user) throw new BadRequestError("User not found");
  if (req.params.id !== userId.toString())
    throw new BadRequestError("You can't update other user's profile!");

  // if (password) {
  //   const salt = await bcrypt.genSalt(10);
  //   const hashedPassword = await bcrypt.hash(password, salt);
  //   user.password = hashedPassword;
  // }

  const urlRegex = /(https?:\/\/[^\s]+)/g;
  for (const [key, value] of Object.entries(payload)) {
    let valueUpdate = null;
    switch (key) {
      case "avatar":
        if (value !== user.avatar) {
          valueUpdate = await uploadFileFromBase64({
            base64: value,
          });
        }
        break;
      case "links":
        const checkLinks = (value as string[]).every(
          (link) => link.match(urlRegex)?.length > 0,
        );
        if (checkLinks) {
          valueUpdate = value;
        }
        break;
      default:
        valueUpdate = value;
    }
    if (valueUpdate) {
      user[key] = valueUpdate;
    }
  }

  user = await user.save();
  const result = await getUserInfo(userId);
  delete result.password;

  new OK({
    message: "Update user successfully",
    metadata: result,
  }).send(res);
};

export const changePassword = async (req, res) => {
  const { currentPW, newPW } = req.body;
  const forgotPW = req.body?.forgotPW;
  const userId = req.params.id;
  if (!userId) {
    throw new BadRequestError("Empty userId");
  }
  if ((!currentPW || !newPW) && !forgotPW) {
    throw new BadRequestError("Empty payload");
  }
  const user = await User.findOne({ _id: ObjectId(userId) });
  if (!user) {
    throw new BadRequestError("User not found");
  }
  let isCurrentPWCorrect = false;
  if (user.password) {
    if (user.password.startsWith("$2a$") || user.password.startsWith("$2b$")) {
      isCurrentPWCorrect = await bcrypt.compare(currentPW, user.password);
    } else {
      isCurrentPWCorrect = user.password === currentPW;
    }
  }

  if (!isCurrentPWCorrect && !forgotPW) {
    throw new AuthFailureError("Wrong password");
  } else if (newPW.length < 6) {
    throw new BadRequestError("Password must be at least 6 characters");
  } else if (currentPW === newPW && !forgotPW) {
    throw new BadRequestError("Nothing change");
  }

  const hashedNewPW = await bcrypt.hash(newPW, 10);
  await User.updateOne(
    { _id: ObjectId(userId) },
    {
      password: hashedNewPW,
    },
  );
  new OK({
    message: "Change password successfully",
    metadata: {},
  }).send(res);
};

// get current authenticated user profile
export const getMe = async (req, res) => {
  if (!req.user?._id) {
    throw new AuthFailureError("Unauthorized");
  }
  const user: IUser | null = await getUserInfo(req.user._id);
  if (!user) throw new BadRequestError("User not found!");
  new OK({
    message: "Get current user profile successfully",
    metadata: user,
  }).send(res);
};

//get user profile
export const getUserProfile = async (req, res) => {
  const { userId } = req.params;
  let user = null;
  if (!userId) {
    throw new BadRequestError("Empty payload");
  }
  user = await getUserInfo(userId, { includeRelations: false });
  if (!user) throw new BadRequestError("User not found!");
  new OK({
    message: "Get user profile successfully",
    metadata: user,
  }).send(res);
};

export const getUserToFollows = async (req, res) => {
  const { userId, page, limit, searchValue } = req.query;
  const isTest = req.query?.isTest ?? false;
  if (isTest) {
    const users = await User.find(
      {},
      {
        _id: 1,
        username: 1,
        avatar: 1,
      },
    ).limit(20);
    return new OK({
      message: "Get users to follow (test) successfully",
      metadata: users,
    }).send(res);
  }
  if (!page || !limit) {
    throw new BadRequestError("Need page and limit");
  }

  let invalidToFollow: any[] = [];
  let userCatesCare: any[] = [];

  if (userId) {
    const userInfo = await User.findOne({ _id: ObjectId(userId) });
    userCatesCare = userInfo?.catesCare ?? [];
    invalidToFollow = [ObjectId(userId)];
  }

  const agg = [
    {
      $match: {
        ...(invalidToFollow.length ? { _id: { $nin: invalidToFollow } } : {}),
        ...(searchValue ? { username: { $regex: searchValue, $options: "i" } } : {}),
      },
    },
    {
      $addFields: {
        matchedCategories: {
          $filter: {
            input: "$catesCare",
            as: "category",
            cond: { $in: ["$$category", userCatesCare] },
          },
        },
      },
    },
    {
      $addFields: {
        score: {
          $add: [
            {
              $multiply: [
                { $size: { $ifNull: ["$matchedCategories", []] } },
                5,
              ],
            },
            { $multiply: [{ $ifNull: ["$followersCount", 0] }, 2] },
          ],
        },
      },
    },
    {
      $sort: { score: -1 },
    },
  ];
  const data = await getUsersByPage({
    page,
    limit,
    agg,
  });
  new OK({
    message: "Get users to follow successfully",
    metadata: data,
  }).send(res);
};

export const handleCrawlFakeUsers = async (req, res) => {
  await crawlUser();
  new OK({
    message: "Crawl success",
    metadata: {},
  }).send(res);
};

export const getUsersFollow = async (req, res) => {
  const { userId, type } = req.query;
  if (!userId) {
    throw new BadRequestError("Empty userId");
  }
  if (type !== "followed" && type !== "following") {
    throw new BadRequestError("Invalid type");
  }
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 50);

  const userInfo = await User.findOne({ _id: ObjectId(userId) });
  if (!userInfo) {
    throw new NotFoundError("Invalid user");
  }

  const isFollowed = type === "followed";
  const filter = isFollowed
    ? { followeeId: ObjectId(userId) }
    : { followerId: ObjectId(userId) };
  const idField = isFollowed ? "followerId" : "followeeId";

  const follows = await Follow.find(filter, { [idField]: 1 })
    .sort({ _id: -1 })
    .skip((page - 1) * limit)
    .limit(limit + 1);
  const hasMore = follows.length > limit;
  const ids = follows.slice(0, limit).map((f) => f[idField]);

  const users = await User.find(
    { _id: { $in: ids } },
    {
      _id: 1,
      avatar: 1,
      username: 1,
      name: 1,
      bio: 1,
    },
  );
  const usersById = new Map(users.map((u) => [String(u._id), u]));
  const orderedUsers = ids
    .map((id) => usersById.get(String(id)))
    .filter(Boolean);

  new OK({
    message: "Get users follow successfully",
    metadata: {
      users: orderedUsers,
      hasMore,
    },
  }).send(res);
};

export const getUsersToTag = async (req, res) => {
  let { userId, page, limit, searchValue } = req.query;
  if (!userId) {
    throw new AuthFailureError("Unauthorize");
  }
  if (!page) {
    page = 1;
  }
  if (!limit) {
    limit = 20;
  }
  const agg = [
    {
      $match: {
        $and: [
          {
            $or: [
              { username: { $regex: searchValue, $options: "i" } },
              { name: { $regex: searchValue, $options: "i" } },
            ],
          },
          { _id: { $ne: ObjectId(userId) } },
        ],
      },
    },
  ];
  const data = await getUsersByPage({ page, limit, agg });
  new OK({
    message: "Get users to tag successfully",
    metadata: data,
  }).send(res);
};

export const checkValidUser = async (req, res) => {
  const payload = req.body;
  const userId = payload?.userId;
  const userEmail = payload?.userEmail;
  if (!userId && !userEmail) {
    throw new BadRequestError("Empty payload");
  }
  const emailRegex = /\S+@\S+\.\S+/;
  if (!emailRegex.test(userEmail)) {
    throw new BadRequestError("Invalid email type");
  }
  const userInfo = await User.findOne({
    $or: [{ _id: ObjectId(userId) }, { email: userEmail }],
  });
  if (userInfo) {
    new OK({
      message: "User is valid",
      metadata: true,
    }).send(res);
  } else {
    new OK({
      message: "User is not valid",
      metadata: false,
    }).send(res);
  }
};

export const getUserIdFromEmail = async (req, res) => {
  const { userEmail } = req.body;
  if (!userEmail) {
    throw new BadRequestError("Empty email");
  }
  const userInfo = await User.findOne({
    email: userEmail,
  });
  new OK({
    message: "Get user id from email successfully",
    metadata: userInfo._id,
  }).send(res);
};

export const getUsersPendingPost = async (req, res) => {
  const { userId, page, limit, searchValue } = req.body;
  const skip = (page - 1) * limit;
  if (!userId) {
    throw new AuthFailureError("Unauthorize");
  }
  if (!page || !limit) {
    throw new BadRequestError("Need page and limit");
  }
  const userInfo = await User.findOne({ _id: ObjectId(userId) });
  const isAdmin = userInfo?.role === Constants.USER_ROLE.ADMIN;
  if (!isAdmin) {
    throw new AuthFailureError("Only for admin");
  }
  const authorIds = (
    await Post.find(
      { status: Constants.POST_STATUS.PRE_ACCEPT },
      { _id: 0, authorId: 1 },
    ).lean()
  )?.map(({ authorId }) => authorId);
  const users = await User.find(
    {
      _id: { $in: authorIds },
      username: { $regex: searchValue, $options: "i" },
    },
    {
      _id: 1,
      username: 1,
      avatar: 1,
    },
  )
    .skip(skip)
    .limit(limit);
  new OK({
    message: "Get users pending post successfully",
    metadata: users,
  }).send(res);
};

export const getUsersWithStatus = async (req, res) => {
  const { userId, page, limit, searchValue } = req.query;
  if (!userId) {
    throw new BadRequestError("Empty userId");
  }
  const userInfo = await User.findOne({
    _id: ObjectId(userId),
  });
  const isAdmin = userInfo.role === Constants.USER_ROLE.ADMIN;
  if (!isAdmin) {
    throw new AuthFailureError("You don't have access to this");
  }
  let agg = searchValue
    ? [
        {
          $match: {
            username: { $regex: searchValue, $options: "i" },
          },
        },
      ]
    : [];
  const data = await getUsersByPage({
    page,
    limit,
    agg,
  });
  const count = await User.countDocuments(agg);
  new OK({
    message: "Get users with status successfully",
    metadata: {
      count,
      users: data,
    },
  }).send(res);
};

// Task 003 (epic seo-sitemap-schema, FR-2): danh sách user ACTIVE đủ điều kiện sitemap, sibling
// của `getSitemapEligiblePosts` (post.controller.ts, task 002) — cùng cursor-phân-trang theo `_id`,
// cùng chốt `totalCount` CHỈ tính ở trang đầu (tránh `countDocuments` lặp lại mỗi trang trên tập
// ~874K record; trang sau trả `totalCount: null`).
export const getSitemapEligibleUsers = async (req, res) => {
  const { cursor, limit } = req.query as { cursor?: string; limit: number };

  const baseFilter = {
    status: Constants.USER_STATUS.ACTIVE,
    followersCount: { $gte: 10 },
  };
  const findFilter = cursor ? { ...baseFilter, _id: { $gt: cursor } } : baseFilter;

  const users = await User.find(findFilter)
    .sort({ _id: 1 })
    .limit(limit)
    .select("_id updatedAt followersCount")
    .lean();

  const totalCount = cursor ? null : await User.countDocuments(baseFilter);

  const data = users.map((user: any) => ({
    userId: user._id.toString(),
    updatedAt: user.updatedAt,
  }));
  const nextCursor =
    users.length === limit ? data[data.length - 1].userId : null;

  new OK({
    message: "Get sitemap-eligible users successfully",
    metadata: { data, nextCursor, totalCount },
  }).send(res);
};
