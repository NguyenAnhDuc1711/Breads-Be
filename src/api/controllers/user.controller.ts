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
import HTTPStatus from "../../utils/httpStatus.js";
import { ObjectId } from "../../utils/index.js";
import { crawlUser } from "../crawl.js";
import Follow from "../models/follow.model.js";
import Post from "../models/post.model.js";
import SavedPost from "../models/savedPost.model.js";
import User from "../models/user.model.js";
import { getUserInfo, getUsersByPage, toggleFollow } from "../services/user.js";
import { sendMailService } from "../services/util.js";
import generateTokenAndSetCookie from "../utils/genarateTokenAndSetCookie.js";
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
    return res.status(HTTPStatus.CREATED).json(result);
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

  // const salt = await bcrypt.genSalt(10);
  // const hashPassword = await bcrypt.hash(password, salt);

  // const newUser = new User({
  //   name,
  //   email,
  //   username,
  //   password: password,
  // });
  // await newUser.save();

  // if (newUser) {
  //   // generateTokenAndSetCookie(newUser._id, res);
  //   res.status(HTTPStatus.CREATED).json({ message: "Tạo mới thành công" });
  // } else {
  //   res
  //     .status(HTTPStatus.BAD_REQUEST)
  //     .json({ error: "Tạo mới không thành công" });
  // }
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

  // generateTokenAndSetCookie(user._id, res);
  const result = await getUserInfo(user._id);
  generateTokenAndSetCookie(user._id, res);

  new OK({
    message: "Login successfully",
    metadata: result,
  }).send(res);
};

// logout
export const logoutUser = async (req, res) => {
  res.cookie("jwt", "", { maxAge: 1 });
  new OK({
    message: "User log out successfully",
    metadata: {},
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
  res.status(HTTPStatus.OK).json(user);
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
    return res.status(HTTPStatus.OK).json(users);
  }
  if (!userId) {
    throw new AuthFailureError("Unauthorize");
  }
  if (!page || !limit) {
    throw new BadRequestError("Need page and limit");
  }
  const userInfo = await User.findOne({ _id: ObjectId(userId) });
  const userCatesCare = userInfo?.catesCare;
  // let userFollowed = userInfo?.following ?? [];
  // userFollowed = userFollowed.map((id) => ObjectId(id));
  // const invalidToFollow = [...userFollowed, ObjectId(userId)];
  const invalidToFollow = [ObjectId(userId)];

  const agg = [
    {
      $match: {
        _id: { $nin: invalidToFollow },
        username: { $regex: searchValue, $options: "i" },
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
  const { userId } = req.query;
  if (!userId) {
    throw new BadRequestError("Empty userId");
  }
  const userInfo = await User.findOne({ _id: ObjectId(userId) });
  if (!userInfo) {
    throw new NotFoundError("Invalid user");
  }
  const followerIds = (
    await Follow.find({ followeeId: ObjectId(userId) }, { followerId: 1 })
  ).map(({ followerId }) => followerId);
  const followeeIds = (
    await Follow.find({ followerId: ObjectId(userId) }, { followeeId: 1 })
  ).map(({ followeeId }) => followeeId);
  const followedUsers = await User.find(
    {
      _id: { $in: followerIds },
    },
    {
      _id: 1,
      avatar: 1,
      username: 1,
      name: 1,
      bio: 1,
    },
  );
  const followingUsers = await User.find(
    {
      _id: { $in: followeeIds },
    },
    {
      _id: 1,
      avatar: 1,
      username: 1,
      name: 1,
      bio: 1,
    },
  );
  new OK({
    message: "Get users follow successfully",
    metadata: {
      followed: followedUsers,
      following: followingUsers,
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
      { status: Constants.POST_STATUS.PENDING },
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
    return res.status(HTTPStatus.BAD_REQUEST).json({ error: "Empty userId" });
  }
  const userInfo = await User.findOne({
    _id: ObjectId(userId),
  });
  const isAdmin = userInfo.role === Constants.USER_ROLE.ADMIN;
  if (!isAdmin) {
    return res
      .status(HTTPStatus.UNAUTHORIZED)
      .json("You don't have access to this");
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
  console.log("count: ", count);
  new OK({
    message: "Get users with status successfully",
    metadata: {
      count,
      users: data,
    },
  }).send(res);
};
