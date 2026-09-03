import { SITEMAP_MAX_RECORDS } from "../../Breads-Shared/APIConfig.js";
import { Constants } from "../../Breads-Shared/Constants/index.js";
import { IUser } from "../../Breads-Shared/Types/index.js";
import { genRandomCode } from "../../Breads-Shared/util/index.js";
import {
  AuthFailureError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../../core/error.response.js";
import { CREATED, OK } from "../../core/success.response.js";
import { deleteCache, getCache, getRedisInstance, setCache } from "../../dbs/redis.ts";
import { ObjectId } from "../../utils/index.js";
import { crawlUser } from "../crawl.js";
import Follow from "../models/follow.model.js";
import FollowSuggestion from "../models/followSuggestion.model.js";
import Post from "../models/post.model.js";
import User from "../models/user.model.js";
import { getUserInfo, getUsersByPage, toggleFollow } from "../services/user.js";
import { FOLLOW_SUGGESTION_CONFIG } from "../services/followSuggestion/config.ts";
import { enqueueOnDemandSuggestion } from "../services/followSuggestion/queue.ts";
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
import { forgotPWMailForm, uploadFileFromBase64, validateEmailForm } from "../utils/index.js";
import ALLOWED_ORIGINS from "../../utils/allowedOrigins.ts";
import { isAccountRestricted } from "../../utils/accountStatus.ts";
import { assertRole } from "../middlewares/requireRole.js";

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

  const expireTime = 10;
  const code = genRandomCode();
  const result = await sendMailService({
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
        enqueueOnDemandSuggestion(String(newUser._id));
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

  const INVALID_CREDENTIALS = "Email hoặc mật khẩu không đúng";
  if (!user) {
    throw new AuthFailureError(INVALID_CREDENTIALS);
  }

  let isPasswordCorrect = false;
  if (user.password) {
    if (user.password.startsWith("$2a$") || user.password.startsWith("$2b$")) {
      isPasswordCorrect = await bcrypt.compare(password, user.password);
    } else {
      if (password === user.password) {
        isPasswordCorrect = true;
        const hashedPassword = await bcrypt.hash(password, 10);
        await User.updateOne({ _id: user._id }, { password: hashedPassword });
      }
    }
  }

  if (!isPasswordCorrect) {
    throw new AuthFailureError(INVALID_CREDENTIALS);
  }

  if (isAccountRestricted(user.status)) {
    logger.warn(
      { userId: String(user._id), status: user.status },
      "login bị từ chối — tài khoản đang bị khoá/cấm",
    );
    throw new ForbiddenError(
      user.statusReason
        ? `Tài khoản đang bị hạn chế: ${user.statusReason}`
        : "Tài khoản đang bị hạn chế",
    );
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
    logger.warn(
      { hashedToken: hashedToken.substring(0, 16) + "..." },
      "Refresh token reuse detected — possible token theft",
    );

    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      try {
        const jwt = await import("jsonwebtoken");
        const decoded: any = jwt.default.decode(
          authHeader.split(" ")[1],
        );
        if (decoded?.userId) {
          await RefreshToken.deleteMany({ userId: decoded.userId });
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

  if (storedToken.expiresAt < new Date()) {
    await RefreshToken.deleteOne({ _id: storedToken._id });
    clearRefreshTokenCookie(res);
    throw new AuthFailureError("Refresh token expired");
  }

  await RefreshToken.deleteOne({ _id: storedToken._id });

  const userId = storedToken.userId.toString();
  const { accessToken } = await generateTokens(userId, res);

  new OK({
    message: "Token refreshed successfully",
    metadata: { accessToken },
  }).send(res);
};

//follow and unfollow
export const followUser = async (req, res) => {
  const { userFlId } = req.body;
  const userId = String(req.user._id);
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

export const getUserAdminDetail = async (req, res) => {
  const { id } = req.params;
  const user = await User.findById(id).select(
    "name username avatar bio email role status statusReason createdAt lastActiveAt followersCount followingCount",
  );
  if (!user) throw new NotFoundError("User not found");
  new OK({
    message: "Get user admin detail successfully",
    metadata: user,
  }).send(res);
};

const VALID_ROLES = Object.values(Constants.USER_ROLE);
const VALID_STATUSES = Object.values(Constants.USER_STATUS);

export const adminUpdateUser = async (req, res) => {
  const { id } = req.params;
  const { role, status, reason } = req.body;

  if (role !== undefined && !VALID_ROLES.includes(role)) {
    throw new BadRequestError("Invalid role");
  }
  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    throw new BadRequestError("Invalid status");
  }

  const user = await User.findById(id);
  if (!user) throw new NotFoundError("User not found");

  if (role !== undefined) user.role = role;
  if (status !== undefined) user.status = status;
  if (reason !== undefined) user.statusReason = reason;
  await user.save();

  new OK({
    message: "Update user role/status successfully",
    metadata: {
      _id: user._id,
      role: user.role,
      status: user.status,
      statusReason: user.statusReason,
    },
  }).send(res);
};

export const changePassword = async (req, res) => {
  const { currentPW, newPW } = req.body;
  const userId = req.params.id;
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

  if (!isCurrentPWCorrect) {
    throw new AuthFailureError("Wrong password");
  }
  if (currentPW === newPW) {
    throw new BadRequestError("Nothing change");
  }

  await applyNewPassword(user._id, newPW, {
    keepRefreshTokenRaw: req.cookies?.refreshToken,
  });

  new OK({
    message: "Change password successfully",
    metadata: {},
  }).send(res);
};

const PW_RESET_TTL_SECONDS = 15 * 60;
const PW_RESET_MAX_ATTEMPTS = 5;

const pwResetCacheKey = (userId: string) => `pw_reset_${userId}`;

type PwResetEntry = { codeHash: string; attempts: number };

const hashResetCode = (code: string) => hashToken(code.toUpperCase());

const consumeResetCode = async (
  userId: string,
  code: string,
  { deleteOnSuccess }: { deleteOnSuccess: boolean },
): Promise<boolean> => {
  const key = pwResetCacheKey(userId);
  const entry = await getCache<PwResetEntry>(key);
  if (!entry?.codeHash) return false;

  if (entry.codeHash !== hashResetCode(code)) {
    const attempts = (entry.attempts ?? 0) + 1;
    if (attempts >= PW_RESET_MAX_ATTEMPTS) {
      await deleteCache(key);
    } else {
      const ttl = await getRemainingTtl(key);
      if (ttl > 0) await setCache(key, { ...entry, attempts }, ttl);
    }
    return false;
  }

  if (deleteOnSuccess) await deleteCache(key);
  return true;
};

const getRemainingTtl = async (key: string): Promise<number> => {
  const redis = getRedisInstance();
  if (!redis) return 0;
  try {
    return await redis.ttl(key);
  } catch {
    return 0;
  }
};

const applyNewPassword = async (
  userId: any,
  newPW: string,
  { keepRefreshTokenRaw }: { keepRefreshTokenRaw?: string } = {},
) => {
  const hashedNewPW = await bcrypt.hash(newPW, 10);
  await User.updateOne({ _id: ObjectId(String(userId)) }, { password: hashedNewPW });

  const filter: any = { userId: ObjectId(String(userId)) };
  if (keepRefreshTokenRaw) {
    filter.token = { $ne: hashToken(keepRefreshTokenRaw) };
  }
  await RefreshToken.deleteMany(filter);
};

export const requestPasswordReset = async (req, res) => {
  const { email } = req.body;
  const user = await User.findOne({ email }, { _id: 1 }).lean();

  if (user) {
    const code = genRandomCode();
    const expireMinutes = PW_RESET_TTL_SECONDS / 60;
    const clientOrigin =
      process.env.FE_BASE_URL || ALLOWED_ORIGINS[0] || "http://localhost:3000";
    const url = `${clientOrigin}/reset-pw/${user._id}/${code}`;

    await setCache(
      pwResetCacheKey(String(user._id)),
      { codeHash: hashResetCode(code), attempts: 0 } as PwResetEntry,
      PW_RESET_TTL_SECONDS,
    );
    await sendMailService({
      from: undefined,
      to: email,
      subject: "Reset password",
      html: forgotPWMailForm(email, code, url),
    });
    logger.info({ userId: String(user._id), expireMinutes }, "password reset code issued");
  }

  new OK({
    message: "If the email exists, a reset code has been sent",
    metadata: {},
  }).send(res);
};

export const verifyPasswordResetCode = async (req, res) => {
  const { email, code } = req.body;
  const user = await User.findOne({ email }, { _id: 1 }).lean();
  const isValid =
    !!user && (await consumeResetCode(String(user._id), code, { deleteOnSuccess: false }));

  if (!isValid) {
    throw new BadRequestError("Invalid or expired code");
  }

  new OK({
    message: "Code verified",
    metadata: { userId: String(user!._id) },
  }).send(res);
};

export const confirmPasswordReset = async (req, res) => {
  const { userId, code, newPW } = req.body;
  const user = await User.findOne({ _id: ObjectId(userId) }, { _id: 1 }).lean();
  if (!user) {
    throw new BadRequestError("Invalid or expired code");
  }

  const isValid = await consumeResetCode(String(userId), code, { deleteOnSuccess: true });
  if (!isValid) {
    throw new BadRequestError("Invalid or expired code");
  }

  await applyNewPassword(userId, newPW);
  logger.info({ userId: String(userId) }, "password reset completed — all sessions revoked");

  new OK({
    message: "Password has been reset",
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

const FALLBACK_CANDIDATE_POOL_SIZE = 2000;

const buildFollowSuggestionFallbackAgg = (
  excludeIds: any[],
  searchValue: any,
  userCatesCare: any[],
) => [
  {
    $match: {
      ...(excludeIds.length ? { _id: { $nin: excludeIds } } : {}),
      ...(searchValue ? { username: { $regex: searchValue, $options: "i" } } : {}),
    },
  },
  { $sort: { followersCount: -1 } },
  { $limit: FALLBACK_CANDIDATE_POOL_SIZE },
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

const buildFollowSuggestionCacheResponse = async (
  candidates: any[],
  excludeIds: any[],
  page: any,
  limit: any,
) => {
  const excludeSet = new Set(excludeIds.map((id) => String(id)));
  const filtered = candidates.filter((c) => !excludeSet.has(String(c.userId)));
  const skip = Number((page - 1) * limit);
  const pageIds = filtered.slice(skip, skip + Number(limit)).map((c) => c.userId);
  if (pageIds.length === 0) return [];
  const users = await User.find(
    { _id: { $in: pageIds } },
    { _id: 1, avatar: 1, username: 1, name: 1, bio: 1, status: 1 },
  ).lean();
  const usersById = new Map(users.map((u: any) => [String(u._id), u]));
  return pageIds.map((id) => usersById.get(String(id))).filter(Boolean);
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
  let followedIds: any[] = [];

  if (userId) {
    const userInfo = await User.findOne({ _id: ObjectId(userId) });
    userCatesCare = userInfo?.catesCare ?? [];
    invalidToFollow = [ObjectId(userId)];
    followedIds = await Follow.find({ followerId: ObjectId(userId) }).distinct("followeeId");
  }
  const excludeIds = [...invalidToFollow, ...followedIds];

  const runFallback = () =>
    getUsersByPage({
      page,
      limit,
      agg: buildFollowSuggestionFallbackAgg(excludeIds, searchValue, userCatesCare),
    });

  let data;
  if (userId && FOLLOW_SUGGESTION_CONFIG.enabled) {
    try {
      const cached = await FollowSuggestion.findOne({ userId: ObjectId(userId) }).lean();
      if (cached?.candidates?.length) {
        data = await buildFollowSuggestionCacheResponse(cached.candidates, excludeIds, page, limit);
      } else {
        if (!cached) {
          enqueueOnDemandSuggestion(String(userId));
        }
        data = await runFallback();
      }
    } catch (err) {
      logger.error({ err }, "getUserToFollows: FollowSuggestion cache read failed, using fallback");
      data = await runFallback();
    }
  } else {
    data = await runFallback();
  }

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

export const getUsersPendingPost = async (req, res) => {
  const { page, limit, searchValue } = req.body;
  const userId = req.user._id;
  const skip = (page - 1) * limit;
  if (!page || !limit) {
    throw new BadRequestError("Need page and limit");
  }
  const userInfo = await User.findOne({ _id: ObjectId(userId) });
  const allowedRoles = [Constants.USER_ROLE.ADMIN, Constants.USER_ROLE.MODERATOR];
  if (!allowedRoles.includes(userInfo?.role)) {
    throw new AuthFailureError("Admin/Moderator only");
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
  const { page, limit, searchValue, role, status, dateFrom, dateTo } = req.query;
  assertRole(req.user, Constants.USER_ROLE.ADMIN);

  const match: Record<string, unknown> = {};
  if (searchValue) match.username = { $regex: searchValue, $options: "i" };
  if (role !== undefined) match.role = role;

  if (status !== undefined) {
    const { ACTIVE, INACTIVE, LOCK, BANNED } = Constants.USER_STATUS;
    const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;
    const threshold = new Date(Date.now() - ONLINE_THRESHOLD_MS);

    if (status === ACTIVE) {
      match.lastActiveAt = { $gte: threshold };
      match.status = { $nin: [LOCK, BANNED] };
    } else if (status === INACTIVE) {
      match.$and = [
        { status: { $nin: [LOCK, BANNED] } },
        {
          $or: [
            { lastActiveAt: { $lt: threshold } },
            { lastActiveAt: { $exists: false } },
          ],
        },
      ];
    } else {
      match.status = status;
    }
  }

  if (dateFrom || dateTo) {
    match.createdAt = {
      ...(dateFrom ? { $gte: dateFrom } : {}),
      ...(dateTo ? { $lte: dateTo } : {}),
    };
  }

  const agg = Object.keys(match).length ? [{ $match: match }] : [];
  const data = await getUsersByPage({
    page,
    limit,
    agg,
  });
  const count = await User.countDocuments(match);
  new OK({
    message: "Get users with status successfully",
    metadata: {
      count,
      users: data,
    },
  }).send(res);
};

export const getSitemapEligibleUsers = async (req, res) => {
  const { cursor, limit } = req.query as { cursor?: string; limit: number };
  const [cursorScore, cursorId] = cursor ? cursor.split(":") : [undefined, undefined];

  const baseFilter = {
    status: Constants.USER_STATUS.ACTIVE,
    followersCount: { $gte: 10 },
  };
  const findFilter = cursor
    ? {
        ...baseFilter,
        $or: [
          { followersCount: { $lt: Number(cursorScore) } },
          { followersCount: Number(cursorScore), _id: { $lt: cursorId } },
        ],
      }
    : baseFilter;

  const users = await User.find(findFilter)
    .sort({ followersCount: -1, _id: -1 })
    .limit(limit)
    .select("_id updatedAt followersCount")
    .lean();

  const totalCount = cursor
    ? null
    : Math.min(await User.countDocuments(baseFilter), SITEMAP_MAX_RECORDS);

  const dataWithScore = users.map((user: any) => ({
    userId: user._id.toString(),
    updatedAt: user.updatedAt,
    followersCount: user.followersCount,
  }));
  const data = dataWithScore.map(({ userId, updatedAt }) => ({ userId, updatedAt }));
  const nextCursor =
    users.length === limit
      ? `${dataWithScore[dataWithScore.length - 1].followersCount}:${data[data.length - 1].userId}`
      : null;

  new OK({
    message: "Get sitemap-eligible users successfully",
    metadata: { data, nextCursor, totalCount },
  }).send(res);
};
