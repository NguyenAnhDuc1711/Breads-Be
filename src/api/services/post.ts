import { Constants } from "../../Breads-Shared/Constants/index.js";
import PageConstant from "../../Breads-Shared/Constants/PageConstants.js";
import PostConstants from "../../Breads-Shared/Constants/PostConstants.js";
import { destructObjectId, ObjectId } from "../../utils/index.js";
import Category from "../models/category.model.js";
import Follow from "../models/follow.model.js";
import Like from "../models/like.model.js";
import Post from "../models/post.model.js";
import SavedPost from "../models/savedPost.model.js";
import SurveyOption from "../models/surveyOption.model.js";
import User from "../models/user.model.js";

export const getPostDetail = async ({
  postId = "",
  postIds = [],
  getFullInfo = false,
  viewerId = null,
}) => {
  const isBulk = postIds && postIds.length > 0;
  try {
    const targetIds = isBulk
      ? postIds.map((id) => ObjectId(id))
      : [ObjectId(postId)];

    const getRelativeProp = [
      {
        $lookup: {
          from: "users",
          let: { searchId: { $toObjectId: "$authorId" } },
          pipeline: [
            { $match: { $expr: { $eq: ["$$searchId", "$_id"] } } },
            {
              $project: {
                _id: 1,
                username: 1,
                avatar: 1,
                bio: 1,
                name: 1,
                followersCount: 1,
              },
            },
          ],
          as: "authorInfo",
        },
      },
      { $unwind: "$authorInfo" },
      {
        $lookup: {
          from: "surveyoptions",
          localField: "survey",
          foreignField: "_id",
          as: "survey",
        },
      },
      {
        $lookup: {
          from: "links",
          localField: "links",
          foreignField: "_id",
          as: "linksInfo",
        },
      },
      {
        $lookup: {
          from: "files",
          localField: "files",
          foreignField: "_id",
          as: "files",
        },
      },
    ];

    const agg: any[] = [
      { $match: { _id: { $in: targetIds } } },
      {
        $lookup: {
          from: "posts",
          let: { searchId: { $toObjectId: "$parentPost" } },
          pipeline: [{ $match: { $expr: { $eq: ["$$searchId", "$_id"] } } }],
          as: "parentPostInfo",
        },
      },
      ...getRelativeProp,
    ];

    if (getFullInfo) {
      agg.push({
        $lookup: {
          from: "posts",
          localField: "replies",
          foreignField: "_id",
          pipeline: [...getRelativeProp],
          as: "replies",
        },
      });
    }

    const posts = await Post.aggregate(agg);
    if (!posts || posts.length === 0) return isBulk ? [] : null;

    // 1. Lấy danh sách ID đã được viewer like (chỉ 1 query batch cho tất cả bài)
    let likedPostSet = new Set<string>();
    if (viewerId) {
      const likedDocs = await Like.find(
        { userId: ObjectId(viewerId), postId: { $in: targetIds } },
        { postId: 1 },
      );
      likedPostSet = new Set(likedDocs.map((doc) => doc.postId.toString()));
    }

    // 2. Đếm số repost cho tất cả bài trong 1 query duy nhất
    const repostCounts = await Post.aggregate([
      { $match: { parentPost: { $in: targetIds } } },
      { $group: { _id: "$parentPost", count: { $sum: 1 } } },
    ]);
    const repostMap = new Map(
      repostCounts.map((item) => [item._id.toString(), item.count]),
    );

    // 3. Populate thông tin cho từng bài
    const enrichedPosts = await Promise.all(
      posts.map(async (result) => {
        if (result?.usersTag?.length > 0) {
          result.usersTagInfo = await getUsersTagInfo({
            usersTagId: result.usersTag,
          });
        }

        if (result?.parentPostInfo?.length > 0) {
          result.parentPostInfo = result.parentPostInfo[0];
          const parentPostInfo = result.parentPostInfo;
          parentPostInfo.authorInfo = await User.findOne(
            { _id: ObjectId(parentPostInfo.authorId) },
            {
              _id: 1,
              avatar: 1,
              name: 1,
              username: 1,
              bio: 1,
              followersCount: 1,
            },
          );
          if (parentPostInfo?.survey?.length) {
            parentPostInfo.survey = await SurveyOption.find({
              _id: { $in: parentPostInfo.survey },
            });
          }
          if (parentPostInfo?.usersTag?.length > 0) {
            parentPostInfo.usersTagInfo = await getUsersTagInfo({
              usersTagId: parentPostInfo.usersTag,
            });
          }
        } else {
          delete result.parentPostInfo;
        }

        result.repostNum = repostMap.get(result._id.toString()) || 0;
        result.likedByMe = likedPostSet.has(result._id.toString());
        return result;
      }),
    );

    // 4. Giữ đúng thứ tự sắp xếp (score sort) ban đầu của targetIds
    if (isBulk) {
      const postMap = new Map(enrichedPosts.map((p) => [p._id.toString(), p]));
      return postIds.map((id) => postMap.get(id.toString())).filter(Boolean);
    }

    return enrichedPosts[0] || null;
  } catch (err) {
    console.log("getPostDetail err: ", err);
    return isBulk ? [] : null;
  }
};

const getQueryPostValidation = (filter) => {
  const user = filter.user;
  const postContent = filter?.postContent;
  const postType = filter?.postType;
  if (!user && !postContent && !postType) {
    return { status: Constants.POST_STATUS.PENDING };
  }
  let userQuery = null;
  let postContentQuery = null;
  let postTypeQuery = null;
  if (!!user) {
    userQuery = {
      authorId: ObjectId(user),
    };
  }
  if (!!postContent && postContent?.length > 0) {
    const contentConditions = [];
    const { GIF, IMAGE, VIDEO } = Constants.MEDIA_TYPE;
    postContent.forEach((contentType) => {
      if (contentType === "text") {
        contentConditions.push({
          $and: [{ media: { $size: 0 } }, { survey: { $size: 0 } }],
        });
      } else if (contentType === GIF) {
        contentConditions.push({ "media.type": GIF });
      } else if (contentType === IMAGE) {
        contentConditions.push({ "media.type": IMAGE });
      } else if (contentType === VIDEO) {
        contentConditions.push({ "media.type": VIDEO });
      } else if (contentType === "survey") {
        contentConditions.push({
          $expr: {
            $gt: [{ $size: "$survey" }, 0],
          },
        });
      }
    });
    postContentQuery = {
      $or: contentConditions,
    };
  }
  if (!!postType && postType?.length > 0) {
    const postTypeConditions = postType.map((type) => {
      return {
        type: type,
      };
    });
    postTypeQuery = {
      $or: postTypeConditions,
    };
  }
  const subQueries = [{ status: Constants.POST_STATUS.PENDING }];
  [userQuery, postContentQuery, postTypeQuery].forEach((subQuery) => {
    if (subQuery) {
      subQueries.push(subQuery);
    }
  });
  const query = {
    $and: subQueries,
  };
  return query;
};

export const getForYouPostsId = async ({ userId, skip, limit }) => {
  const userInfo = await User.findOne({
    _id: ObjectId(userId),
  });
  const userCatesCare = userInfo?.catesCare ?? [];
  const { CREATE, EDIT, REPOST } = PostConstants.ACTIONS;
  const data = await Post.aggregate([
    {
      $match: {
        type: { $in: [CREATE, EDIT, REPOST] },
        authorId: { $ne: ObjectId(userId) },
      },
    },
    {
      $addFields: {
        matchedCategories: {
          $filter: {
            input: "$categories",
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
                15,
              ],
            },
            { $multiply: [{ $ifNull: ["$likesCount", 0] }, 3] },
            { $multiply: [{ $size: { $ifNull: ["$replies", []] } }, 3] },
            { $multiply: [{ $size: { $ifNull: ["$media", []] } }, 2] },
            { $size: { $ifNull: ["$survey", []] } },
          ],
        },
      },
    },
    {
      $sort: { score: -1 },
    },
    {
      $skip: skip,
    },
    {
      $limit: parseInt(limit),
    },
    {
      $project: {
        _id: 1,
      },
    },
  ]);
  return data?.map(({ _id }) => _id) ?? [];
};

export const getPostsIdByFilter = async (payload) => {
  try {
    let data = null;
    let { filter, userId, page, limit, isAdminPage } = payload;
    if (!isAdminPage) {
      if (!page) {
        page = 1;
      }
      if (!limit) {
        limit = 20;
      }
    }
    const { PENDING, PUBLIC, ONLY_ME, ONLY_FOLLOWERS, DELETED } =
      Constants.POST_STATUS;
    const skip = (page - 1) * limit;
    let query = {};
    let project = { _id: 1 };
    let sort = { createdAt: -1 };
    switch (filter.page) {
      case PageConstant.SAVED:
        // Order by when the post was saved, not when it was created.
        data = (
          await SavedPost.find({ userId: ObjectId(userId) })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
        ).map(({ postId }) => postId);
        break;
      case PageConstant.USER || PageConstant.FRIEND:
        const value = filter.value;
        let type = value;
        const status = {
          $nin: [PENDING, DELETED],
        };
        if (!value) {
          type = {
            $nin: [PostConstants.ACTIONS.REPLY, PostConstants.ACTIONS.REPOST],
          };
        }
        query = {
          authorId: ObjectId(userId),
          type,
          status,
        };
        break;
      case PageConstant.FOLLOWING:
        const followingIds = (
          await Follow.find({ followerId: ObjectId(userId) }, { followeeId: 1 })
        ).map(({ followeeId }) => followeeId);
        query = {
          type: { $ne: PostConstants.ACTIONS.REPLY },
          authorId: { $in: followingIds },
        };
        break;
      case PageConstant.LIKED:
        // Order by when the post was liked, not when it was created.
        data = (
          await Like.find({ userId: ObjectId(userId) })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
        ).map(({ postId }) => postId);
        break;
      case PageConstant.ADMIN.POSTS_VALIDATION:
        query = getQueryPostValidation(filter);
        break;
      case PageConstant.ADMIN.POSTS:
        sort = { createdAt: 1 };
        break;
      default:
        data = await getForYouPostsId({ userId, skip, limit });
        break;
    }
    if (
      Object.keys(query).length > 0 ||
      filter?.page === PageConstant.ADMIN.POSTS
    ) {
      data = await Post.find(query, project).skip(skip).limit(limit).sort(sort);
    }
    return data;
  } catch (err) {
    console.log("getPostsIdByFilter: ", err);
    return [];
  }
};

export const handleReplyForParentPost = async ({
  parentId,
  replyId,
  addNew,
}) => {
  try {
    const action = addNew
      ? {
          $push: { replies: replyId },
        }
      : {
          $pull: { replies: replyId },
        };
    await Post.updateOne(
      {
        _id: parentId,
      },
      action,
    );
  } catch (err) {
    console.log("handleReplyForParentPost: ", err);
  }
};

export const getUsersTagInfo = async ({ usersTagId }) => {
  try {
    const usersTagInfo = await User.find(
      { _id: { $in: usersTagId } },
      {
        _id: 1,
        avatar: 1,
        name: 1,
        username: 1,
        bio: 1,
        followersCount: 1,
      },
    );
    return usersTagInfo;
  } catch (err) {
    console.log("getUsersTagInfo: ", err);
  }
};

export const getPostsCatesByIds = async ({ postIds }) => {
  try {
    const postsCates = (
      await Post.find(
        {
          _id: {
            $in: postIds,
          },
        },
        {
          _id: 0,
          categories: 1,
        },
      )
    )?.map(({ categories }) =>
      categories.map((cateId) => destructObjectId(cateId)),
    );
    const cateIds = [...new Set(postsCates.flat())];
    return cateIds;
  } catch (err) {
    console.log("getPostsCatesByIds: ", err);
    return [];
  }
};
