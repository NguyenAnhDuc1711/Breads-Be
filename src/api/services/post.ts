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

/** Danh sách followeeId của `viewerId`. Tách riêng để caller có thể fetch 1 lần rồi tái dùng
 * cho cả `buildVisibilityQuery` lẫn `filterViewablePosts` trong cùng request (NFR-1). */
export const getFolloweeIds = async (viewerId: any): Promise<any[]> =>
  (
    await Follow.find({ followerId: ObjectId(viewerId) }, { followeeId: 1 })
  ).map(({ followeeId }) => followeeId);

/**
 * AD-2 — quy tắc "ai được xem bài này", dùng chung cho MỌI read-path:
 *   `authorId == viewerId` HOẶC `visibility == PUBLIC`
 *   HOẶC (`visibility == ONLY_FOLLOWERS` VÀ viewer đang follow author)
 * đồng thời luôn loại `status == DELETED`.
 *
 * KHÔNG loại `status == PRE_ACCEPT` của người khác (AD-5): bài chưa duyệt vẫn hiển thị nếu
 * visibility cho phép — đó chính là lý do đổi `PENDING` -> `PRE_ACCEPT` (fan-out chạy ngay lúc
 * tạo, kiểm duyệt sau).
 *
 * `followeeIds`: danh sách người mà viewer đang follow, truyền vào để tái dùng khi caller đã
 * query sẵn (case FOLLOWING / rebuild ZSET, hoặc `getFolloweeIds` ở trên) — bỏ trống thì hàm tự
 * query 1 lần.
 * `viewerId` null (khách ẩn danh) => chỉ thấy bài PUBLIC.
 *
 * Task 002 đã backfill nên mọi document đều có `visibility` hợp lệ: so khớp trực tiếp,
 * không cần `$exists: false`.
 */
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

/** Bản boolean tương đương `buildVisibilityQuery`, dùng khi đã có sẵn document. */
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
  return false; // ONLY_ME của người khác
};

/**
 * Lọc mảng post đã fetch theo `canViewPost`, dùng ĐÚNG 1 truy vấn `Follow` cho cả mảng
 * (và 0 truy vấn khi không có bài `ONLY_FOLLOWERS` của người khác — trường hợp phổ biến).
 */
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
      // Caller đã fetch followee sẵn trong request này (vd. `buildVisibilityQuery` ở feed) ->
      // tái dùng thay vì query `Follow` lần hai (NFR-1).
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

/**
 * Trang admin (kiểm duyệt) phải đọc được cả bài non-PUBLIC của người khác, nếu không hàng đợi
 * kiểm duyệt sẽ mất bài. Quyền admin lấy từ `role` trong DB của **viewer đã xác thực bằng jwt**,
 * KHÔNG phải từ query string `filter[page]=admin...` — nếu không, cờ admin do client tự khai
 * sẽ trở thành đường vòng qua chính lớp enforce này.
 */
const isAdminViewer = async (viewerId: any): Promise<boolean> => {
  if (!viewerId) return false;
  try {
    const user: any = await User.findOne(
      { _id: ObjectId(viewerId) },
      { role: 1 },
    ).lean();
    return user?.role === Constants.USER_ROLE.ADMIN;
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
  // Followee id list caller đã fetch sẵn (vd. feed "for_you") -> tránh Follow.find lần hai
  // trong filterViewablePosts bên dưới (NFR-1). null = caller chưa có, tự query như cũ.
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

    // Danh sách reply/repost đầy đủ của 1 post giờ lấy qua endpoint phân trang riêng
    // (`getPostReplies`/`GET /:id/replies`), không còn nhúng ở đây — post.replies (mảng) đã bỏ
    // khỏi schema (xem post.model.ts). `repliesCount` là field thường trên chính document nên tự
    // có mặt trong kết quả, không cần lookup.

    // 1. Chạy song song 3 truy vấn độc lập: Aggregation chính, Check Like, và Đếm Repost
    const [posts, likedDocs, repostCounts] = await Promise.all([
      Post.aggregate(agg),
      viewerId
        ? Like.find(
            { userId: ObjectId(viewerId), postId: { $in: targetIds } },
            { postId: 1 },
          )
        : Promise.resolve([]),
      // `parentPost` giờ dùng chung cho cả REPOST lẫn REPLY (trước đây chỉ REPOST) — PHẢI lọc
      // `type` ở đây, nếu không repostNum sẽ đếm nhầm cả reply.
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

    // FR-7/NFR-2: chặn IDOR — truy cập thẳng bằng postId cũng phải qua đúng quy tắc AD-2.
    const isAdmin = await isAdminViewer(isAdminPage ? viewerId : null);
    const viewablePosts = isAdmin
      ? posts
      : await filterViewablePosts(posts, viewerId, followeeIds);
    if (viewablePosts.length === 0) return isBulk ? [] : null;

    const likedPostSet = new Set(likedDocs.map((doc) => doc.postId.toString()));
    const repostMap = new Map(
      repostCounts.map((item) => [item._id.toString(), item.count]),
    );

    // 2. Gom tất cả usersTag IDs từ bài chính lẫn bài cha để query batch 1 lần duy nhất
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

    // 3. Map dữ liệu vào từng bài hoàn toàn in-memory (0 DB round-trip)
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

    // 4. Giữ đúng thứ tự sắp xếp ban đầu của targetIds
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

/**
 * Dựng 3 khối sub-query dùng chung cho cả `admin/posts` và `admin/posts/validation`:
 * lọc theo tác giả (`filter.user`), theo loại nội dung (`filter.postContent`) và theo
 * loại post (`filter.postType`). KHÔNG ràng buộc `status` — mỗi nơi gọi tự thêm nếu cần.
 */
const buildAdminPostFilterSubQueries = (filter) => {
  const user = filter?.user;
  const postContent = filter?.postContent;
  const postType = filter?.postType;
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

/**
 * Fallback phổ quát để dựng pool candidate (không phải nhánh celebrity).
 * Không có `$skip`: pool cố định theo `limit`, phân trang được áp **sau khi chấm điểm**
 * ở `getForYouFeed` (AD-4).
 */
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
  // Lọc visibility NGAY Ở $match đầu tiên (trước `$limit`) — lọc sau `$limit` sẽ làm pool
  // candidate teo lại thay vì được lấp đầy bằng bài viewer thật sự xem được.
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
    // Danh tính người ĐANG XEM, lấy từ jwt (`optionalAuth`) — khác `userId` trong query string,
    // vốn là "feed/trang cá nhân của ai" và client tự khai được. Không có jwt => coi như ẩn danh
    // (fail-closed: chỉ thấy bài PUBLIC).
    const viewerId = payload?.viewerId ?? null;
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
        if (!value) {
          type = {
            $nin: [PostConstants.ACTIONS.REPLY, PostConstants.ACTIONS.REPOST],
          };
        }
        // FR-6/AD-5: chỉ còn loại `DELETED` (do `buildVisibilityQuery` đặt) — bỏ `PRE_ACCEPT`
        // khỏi exclusion, đó là hành vi kế thừa từ thời field còn tên `PENDING`.
        // Tác giả tự xem trang mình khớp nhánh `{ authorId: viewerId }` trong `$or` nên thấy
        // toàn bộ bài của mình bất kể visibility/status; viewer khác bị gate đúng luật.
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
        // NFR-1 escape hatch (Task 090 re-benchmark: shared buildVisibilityQuery's `$or`
        // measured +14-41% p95/median over pre-epic baseline on this path, over the 10%
        // budget). Only valid when `viewerId === userId` — `authorId` is already restricted
        // to `followingIds`, the SAME set the ONLY_FOLLOWERS check would test against, so the
        // generic `$or` (visibility PUBLIC / authorId==viewerId / ONLY_FOLLOWERS+authorId $in
        // followingIds) collapses to a plain `visibility $in [PUBLIC, ONLY_FOLLOWERS]` with
        // identical results but far better index selection. When viewing someone ELSE's
        // following feed (`viewerId !== userId`), `followingIds` is a different person's
        // followee set than the current viewer's — the collapse does NOT hold, so that branch
        // keeps using the shared `buildVisibilityQuery` (AD-2), unchanged from before.
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
        // Order by when the post was liked, not when it was created.
        data = (
          await Like.find({ userId: ObjectId(userId) })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
        ).map(({ postId }) => postId);
        break;
      case PageConstant.ADMIN.POSTS_VALIDATION:
        // FR-3 (epic post-management, task #15 verify): hàng đợi phải FIFO (cũ nhất trước) để
        // tránh bỏ sót bài chờ duyệt lâu — default `sort` ở trên là {createdAt:-1} (mới nhất
        // trước), phải override giống nhánh ADMIN.POSTS.
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
        // Fetch 1 lần, tái dùng cho cả buildVisibilityQuery (bên trong getForYouFeed) lẫn
        // filterViewablePosts (bên trong getPostDetail, gọi sau ở controller) -> đúng 1
        // Follow.find cho cả request thay vì 2 (NFR-1).
        const followeeIds = viewerId ? await getFolloweeIds(viewerId) : [];
        payload.followeeIds = followeeIds;
        data = await getForYouFeed({ userId, viewerId, skip, limit, followeeIds });
        break;
    }
    if (
      Object.keys(query).length > 0 ||
      filter?.page === PageConstant.ADMIN.POSTS
    ) {
      // getPostDetail() expects raw ids in `postIds` (it re-maps results back to this exact
      // array via `id.toString()`) — every other branch above already returns raw ids
      // (SavedPost/Like `.map(({postId}) => postId)`, getForYouFeed's `.map(({_id}) => _id)`).
      // This branch queried `Post.find` directly and returned full `{_id}` documents instead,
      // whose `.toString()` is `"[object Object]"` — the re-map matched nothing, so USER/FRIEND
      // profile pages and the admin post list silently rendered zero posts.
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

/**
 * Cập nhật counter của post CHA khi 1 reply được tạo/xoá. Reply tự lưu `parentPost` trỏ về cha
 * (set lúc `createPost`, xem `post.controller.ts`) — hàm này chỉ còn việc `$inc` 2 counter trên
 * cha, không còn `$push/$pull` vào mảng nhúng (đã bỏ khỏi schema, xem `post.model.ts`).
 */
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

/**
 * Trang reply của 1 post, mới nhất trước. Lọc visibility NGAY TRONG QUERY (qua
 * `buildVisibilityQuery`, không fetch-rồi-lọc như task 090 patch cũ từng làm cho nhánh
 * `getFullInfo`) — quan trọng vì lọc sau `skip`/`limit` sẽ cho ra trang thiếu phần tử (đếm đủ
 * `limit` rồi mới lọc khiến số item hiển thị thực tế < `limit`, sai ngữ nghĩa phân trang). Mỗi
 * reply xét visibility theo TÁC GIẢ CỦA CHÍNH NÓ (đúng như task 090 đã chỉ ra), không phải tác giả
 * bài gốc — `buildVisibilityQuery` vốn đã làm đúng việc này cho bất kỳ document Post nào.
 */
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
