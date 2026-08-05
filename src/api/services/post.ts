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
import { getForYouFeed } from "./feed/index.ts";

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
          pipeline: [
            { $match: { $expr: { $eq: ["$$searchId", "$_id"] } } },
            {
              $lookup: {
                from: "users",
                let: { authorSearchId: { $toObjectId: "$authorId" } },
                pipeline: [
                  { $match: { $expr: { $eq: ["$$authorSearchId", "$_id"] } } },
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
            { $unwind: { path: "$authorInfo", preserveNullAndEmptyArrays: true } },
            {
              $lookup: {
                from: "surveyoptions",
                localField: "survey",
                foreignField: "_id",
                as: "survey",
              },
            },
          ],
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

    // 1. Chạy song song 3 truy vấn độc lập: Aggregation chính, Check Like, và Đếm Repost
    const [posts, likedDocs, repostCounts] = await Promise.all([
      Post.aggregate(agg),
      viewerId
        ? Like.find(
            { userId: ObjectId(viewerId), postId: { $in: targetIds } },
            { postId: 1 },
          )
        : Promise.resolve([]),
      Post.aggregate([
        { $match: { parentPost: { $in: targetIds } } },
        { $group: { _id: "$parentPost", count: { $sum: 1 } } },
      ]),
    ]);

    if (!posts || posts.length === 0) return isBulk ? [] : null;

    const likedPostSet = new Set(likedDocs.map((doc) => doc.postId.toString()));
    const repostMap = new Map(
      repostCounts.map((item) => [item._id.toString(), item.count]),
    );

    // 2. Gom tất cả usersTag IDs từ bài chính lẫn bài cha để query batch 1 lần duy nhất
    const allUserTagIdsSet = new Set<string>();
    posts.forEach((result) => {
      if (result?.usersTag?.length) {
        result.usersTag.forEach((id: any) => allUserTagIdsSet.add(id.toString()));
      }
      if (result?.parentPostInfo?.[0]?.usersTag?.length) {
        result.parentPostInfo[0].usersTag.forEach((id: any) =>
          allUserTagIdsSet.add(id.toString()),
        );
      }
    });

    let userTagMap = new Map<string, any>();
    if (allUserTagIdsSet.size > 0) {
      const userTagIds = Array.from(allUserTagIdsSet).map((id) => ObjectId(id));
      const userTagInfos = await getUsersTagInfo({ usersTagId: userTagIds });
      if (userTagInfos && userTagInfos.length > 0) {
        userTagMap = new Map(userTagInfos.map((u: any) => [u._id.toString(), u]));
      }
    }

    // 3. Map dữ liệu vào từng bài hoàn toàn in-memory (0 DB round-trip)
    const enrichedPosts = posts.map((result) => {
      if (result?.usersTag?.length > 0) {
        result.usersTagInfo = result.usersTag
          .map((id: any) => userTagMap.get(id.toString()))
          .filter(Boolean);
      }

      if (result?.parentPostInfo?.length > 0) {
        result.parentPostInfo = result.parentPostInfo[0];
        const parentPostInfo = result.parentPostInfo;
        if (parentPostInfo?.usersTag?.length > 0) {
          parentPostInfo.usersTagInfo = parentPostInfo.usersTag
            .map((id: any) => userTagMap.get(id.toString()))
            .filter(Boolean);
        }
      } else {
        delete result.parentPostInfo;
      }

      result.repostNum = repostMap.get(result._id.toString()) || 0;
      result.likedByMe = likedPostSet.has(result._id.toString());
      return result;
    });

    // 4. Giữ đúng thứ tự sắp xếp ban đầu của targetIds
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
    return { status: Constants.POST_STATUS.PRE_ACCEPT };
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
  const subQueries = [{ status: Constants.POST_STATUS.PRE_ACCEPT }];
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

/**
 * Fallback phổ quát để dựng pool candidate (không phải nhánh celebrity).
 * Không có `$skip`: pool cố định theo `limit`, phân trang được áp **sau khi chấm điểm**
 * ở `getForYouFeed` (AD-4).
 */
export const getCandidatesFromMongo = async ({ userId, limit }) => {
  const { CREATE, EDIT, REPOST } = PostConstants.ACTIONS;
  const data = await Post.aggregate([
    {
      $match: {
        type: { $in: [CREATE, EDIT, REPOST] },
      },
    },
    {
      $sort: {
        createdAt: -1,
      },
    },
    {
      $match: {
        authorId: { $ne: ObjectId(userId) },
      },
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
    const { PRE_ACCEPT, PUBLIC, ONLY_ME, ONLY_FOLLOWERS, DELETED } =
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
      case PageConstant.USER:
      case PageConstant.FRIEND:
        const value = filter.value;
        let type = value;
        const status = {
          $nin: [PRE_ACCEPT, DELETED],
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
        data = await getForYouFeed({ userId, skip, limit });
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
      ? { $push: { replies: replyId }, $inc: { engagementScore: 3 } }
      : { $pull: { replies: replyId }, $inc: { engagementScore: -3 } };
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
