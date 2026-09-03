import { Constants } from "../../Breads-Shared/Constants/index.js";
import PageConstant from "../../Breads-Shared/Constants/PageConstants.js";
import PostConstants from "../../Breads-Shared/Constants/PostConstants.js";
import { destructObjectId, ObjectId } from "../../utils/index.js";
import logger from "../../core/logger.js";
import Category from "../models/category.model.js";
import Follow from "../models/follow.model.js";
import Like from "../models/like.model.js";
import Post from "../models/post.model.js";
import SavedPost from "../models/savedPost.model.js";
import SurveyOption from "../models/surveyOption.model.js";
import User from "../models/user.model.js";
import { getForYouFeed } from "./feed/index.ts";

export const getFolloweeIds = async (viewerId: any): Promise<any[]> =>
  (
    await Follow.find({ followerId: ObjectId(viewerId) }, { followeeId: 1 })
  ).map(({ followeeId }) => followeeId);

export const buildVisibilityQuery = async (
  viewerId: any = null,
  followeeIds: any[] | null = null,
) => {
  const { PUBLIC, ONLY_FOLLOWERS } = Constants.POST_VISIBILITY;
  const orClauses: any[] = [{ visibility: PUBLIC }];
  if (viewerId) {
    orClauses.push({ authorId: ObjectId(viewerId) });
    const ids = followeeIds ?? (await getFolloweeIds(viewerId));
    if (ids.length > 0) {
      orClauses.push({ visibility: ONLY_FOLLOWERS, authorId: { $in: ids } });
    }
  }
  return {
    status: { $ne: Constants.POST_STATUS.DELETED },
    $or: orClauses,
  };
};

export const canViewPost = (
  viewerId: any,
  post: any,
  isFollowingAuthor = false,
): boolean => {
  if (!post) return false;
  if (post.status === Constants.POST_STATUS.DELETED) return false;
  if (!!viewerId && String(post.authorId) === String(viewerId)) return true;
  const { PUBLIC, ONLY_FOLLOWERS } = Constants.POST_VISIBILITY;
  const visibility = post.visibility ?? PUBLIC;
  if (visibility === PUBLIC) return true;
  if (visibility === ONLY_FOLLOWERS) return !!viewerId && isFollowingAuthor;
  return false;
};

export const filterViewablePosts = async (
  posts: any[],
  viewerId: any,
  followeeIds: any[] | null = null,
) => {
  const { PUBLIC, ONLY_FOLLOWERS } = Constants.POST_VISIBILITY;
  const authorsToCheck = posts
    .filter(
      (post) =>
        (post?.visibility ?? PUBLIC) === ONLY_FOLLOWERS &&
        String(post?.authorId) !== String(viewerId ?? ""),
    )
    .map((post) => ObjectId(String(post.authorId)));
  let followingSet = new Set<string>();
  if (!!viewerId && authorsToCheck.length > 0) {
    if (followeeIds) {
      followingSet = new Set(followeeIds.map((id) => String(id)));
    } else {
      const rows = await Follow.find(
        { followerId: ObjectId(viewerId), followeeId: { $in: authorsToCheck } },
        { followeeId: 1 },
      );
      followingSet = new Set(rows.map(({ followeeId }) => String(followeeId)));
    }
  }
  return posts.filter((post) =>
    canViewPost(viewerId, post, followingSet.has(String(post?.authorId))),
  );
};

export const isAdminViewer = async (viewerId: any): Promise<boolean> => {
  if (!viewerId) return false;
  try {
    const user: any = await User.findOne(
      { _id: ObjectId(viewerId) },
      { role: 1 },
    ).lean();
    return (
      user?.role === Constants.USER_ROLE.ADMIN ||
      user?.role === Constants.USER_ROLE.MODERATOR
    );
  } catch (err) {
    logger.error({ err }, "isAdminViewer failed");
    return false;
  }
};

export const getPostDetail = async ({
  postId = "",
  postIds = [],
  viewerId = null,
  isAdminPage = false,
  followeeIds = null,
}: {
  postId?: any;
  postIds?: any[];
  viewerId?: any;
  isAdminPage?: boolean;
  followeeIds?: any[] | null;
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

    const [posts, likedDocs, repostCounts] = await Promise.all([
      Post.aggregate(agg),
      viewerId
        ? Like.find(
            { userId: ObjectId(viewerId), postId: { $in: targetIds } },
            { postId: 1 },
          )
        : Promise.resolve([]),
      Post.aggregate([
        {
          $match: {
            parentPost: { $in: targetIds },
            type: PostConstants.ACTIONS.REPOST,
          },
        },
        { $group: { _id: "$parentPost", count: { $sum: 1 } } },
      ]),
    ]);

    if (!posts || posts.length === 0) return isBulk ? [] : null;

    const isAdmin = await isAdminViewer(isAdminPage ? viewerId : null);
    const viewablePosts = isAdmin
      ? posts
      : await filterViewablePosts(posts, viewerId, followeeIds);
    if (viewablePosts.length === 0) return isBulk ? [] : null;

    const likedPostSet = new Set(likedDocs.map((doc) => doc.postId.toString()));
    const repostMap = new Map(
      repostCounts.map((item) => [item._id.toString(), item.count]),
    );

    const allUserTagIdsSet = new Set<string>();
    viewablePosts.forEach((result) => {
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

    const enrichedPosts = viewablePosts.map((result) => {
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

    if (isBulk) {
      const postMap = new Map(enrichedPosts.map((p) => [p._id.toString(), p]));
      return postIds.map((id) => postMap.get(id.toString())).filter(Boolean);
    }

    return enrichedPosts[0] || null;
  } catch (err) {
    logger.error({ err }, "getPostDetail failed");
    return isBulk ? [] : null;
  }
};

const toArray = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);

const buildAdminPostFilterSubQueries = (filter) => {
  const user = filter?.user;
  const postContent = toArray(filter?.postContent);
  const postType = toArray(filter?.postType);
  let userQuery = null;
  let postContentQuery = null;
  let postTypeQuery = null;
  if (!!user) {
    userQuery = {
      authorId: ObjectId(user),
    };
  }
  if (postContent.length > 0) {
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
  if (postType.length > 0) {
    const postTypeConditions = postType.map((type) => {
      return {
        type: type,
      };
    });
    postTypeQuery = {
      $or: postTypeConditions,
    };
  }
  return { userQuery, postContentQuery, postTypeQuery };
};

const getQueryPostValidation = (filter) => {
  const user = filter.user;
  const postContent = filter?.postContent;
  const postType = filter?.postType;
  if (!user && !postContent && !postType) {
    return { status: Constants.POST_STATUS.PRE_ACCEPT };
  }
  const { userQuery, postContentQuery, postTypeQuery } =
    buildAdminPostFilterSubQueries(filter);
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

export const getCandidatesFromMongo = async ({
  userId,
  limit,
  viewerId = null,
  followeeIds = null,
}: {
  userId: any;
  limit: any;
  viewerId?: any;
  followeeIds?: any[] | null;
}) => {
  const { CREATE, EDIT, REPOST } = PostConstants.ACTIONS;
  const visibilityQuery = await buildVisibilityQuery(viewerId, followeeIds);
  const data = await Post.aggregate([
    {
      $match: {
        type: { $in: [CREATE, EDIT, REPOST] },
        ...visibilityQuery,
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
    const viewerId = payload?.viewerId ?? null;
    const skip = (page - 1) * limit;
    let query = {};
    let project = { _id: 1 };
    let sort = { createdAt: -1 };
    switch (filter.page) {
      case PageConstant.SAVED:
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
        if (!value) {
          type = {
            $nin: [PostConstants.ACTIONS.REPLY, PostConstants.ACTIONS.REPOST],
          };
        }
        query = {
          authorId: ObjectId(userId),
          type,
          ...(await buildVisibilityQuery(viewerId)),
        };
        break;
      case PageConstant.FOLLOWING:
        const followingIds = (
          await Follow.find({ followerId: ObjectId(userId) }, { followeeId: 1 })
        ).map(({ followeeId }) => followeeId);
        query =
          String(viewerId) === String(userId)
            ? {
                type: { $ne: PostConstants.ACTIONS.REPLY },
                authorId: { $in: followingIds },
                status: { $ne: Constants.POST_STATUS.DELETED },
                visibility: {
                  $in: [
                    Constants.POST_VISIBILITY.PUBLIC,
                    Constants.POST_VISIBILITY.ONLY_FOLLOWERS,
                  ],
                },
              }
            : {
                type: { $ne: PostConstants.ACTIONS.REPLY },
                authorId: { $in: followingIds },
                ...(await buildVisibilityQuery(viewerId)),
              };
        break;
      case PageConstant.LIKED:
        data = (
          await Like.find({ userId: ObjectId(userId) })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
        ).map(({ postId }) => postId);
        break;
      case PageConstant.ADMIN.POSTS_VALIDATION:
        sort = { createdAt: 1 };
        query = getQueryPostValidation(filter);
        break;
      case PageConstant.ADMIN.POSTS: {
        sort = { createdAt: 1 };
        const { userQuery, postContentQuery, postTypeQuery } =
          buildAdminPostFilterSubQueries(filter);
        const dateQuery: { createdAt?: { $gte?: Date; $lte?: Date } } = {};
        if (filter.dateFrom || filter.dateTo) {
          dateQuery.createdAt = {};
          if (filter.dateFrom) dateQuery.createdAt.$gte = new Date(filter.dateFrom);
          if (filter.dateTo) dateQuery.createdAt.$lte = new Date(filter.dateTo);
        }
        const subQueries = [userQuery, postContentQuery, postTypeQuery, dateQuery].filter(
          (q) => q && Object.keys(q).length > 0,
        );
        query = subQueries.length > 0 ? { $and: subQueries } : {};
        break;
      }
      default:
        const followeeIds = viewerId ? await getFolloweeIds(viewerId) : [];
        payload.followeeIds = followeeIds;
        data = await getForYouFeed({ userId, viewerId, skip, limit, followeeIds });
        break;
    }
    if (
      Object.keys(query).length > 0 ||
      filter?.page === PageConstant.ADMIN.POSTS
    ) {
      if (
        filter?.page === PageConstant.ADMIN.POSTS ||
        filter?.page === PageConstant.ADMIN.POSTS_VALIDATION
      ) {
        payload.totalCount = await Post.countDocuments(query);
      }
      data = (
        await Post.find(query, project).skip(skip).limit(limit).sort(sort)
      ).map(({ _id }) => _id);
    }
    return data;
  } catch (err) {
    logger.error({ err }, "getPostsIdByFilter failed");
    return [];
  }
};

export const handleReplyForParentPost = async ({
  parentId,
  addNew,
}) => {
  try {
    const delta = addNew ? 1 : -1;
    await Post.updateOne(
      {
        _id: parentId,
      },
      { $inc: { repliesCount: delta, engagementScore: delta * 3 } },
    );
  } catch (err) {
    logger.error({ err }, "handleReplyForParentPost failed");
  }
};

export const getReplyPage = async ({
  postId,
  viewerId = null,
  followeeIds = null,
  page = 1,
  limit = 20,
}: {
  postId: any;
  viewerId?: any;
  followeeIds?: any[] | null;
  page?: number;
  limit?: number;
}): Promise<{ ids: any[]; total: number }> => {
  const skip = (page - 1) * limit;
  const filter = {
    parentPost: ObjectId(postId),
    type: PostConstants.ACTIONS.REPLY,
    ...(await buildVisibilityQuery(viewerId, followeeIds)),
  };
  const [total, rows] = await Promise.all([
    Post.countDocuments(filter),
    Post.find(filter, { _id: 1 }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  return { ids: rows.map((r: any) => r._id), total };
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
    logger.error({ err }, "getUsersTagInfo failed");
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
    logger.error({ err }, "getPostsCatesByIds failed");
    return [];
  }
};
