import { POST_PATH, Route } from "../../../Breads-Shared/APIConfig.js";
import { Constants } from "../../../Breads-Shared/Constants/index.js";
import PostConstants from "../../../Breads-Shared/Constants/PostConstants.js";
import { getRedisInstance } from "../../../dbs/redis.ts";
import { getAllSockets } from "../../../socket/services/user.ts";
import { ObjectId } from "../../../utils/index.js";
import Follow from "../../models/follow.model.js";
import Post from "../../models/post.model.js";
import User from "../../models/user.model.js";
import { buildVisibilityQuery } from "../post.js";
import { FEED_CONFIG } from "./config.ts";
import {
  BATCH_SIZE,
  chunk,
  zAddPostForUsers,
  zAddPostForUsersOrThrow,
  zAddPostsForUser,
  zExists,
  zRemovePostsForUser,
  zReplaceUserFeed,
} from "./zset.ts";

const DAY_MS = 86400_000;

export const rebuiltSentinelKey = (userId: string): string =>
  `feed:rebuilt:${userId}`;

const SENTINEL_TTL_SECONDS = 60;

const activeCutoff = (): Date =>
  new Date(Date.now() - FEED_CONFIG.activeWindowDays * DAY_MS);

const setRebuiltSentinel = async (userId: string): Promise<void> => {
  const r = getRedisInstance();
  if (!r) {
    console.warn("[feed-rebuild] sentinel: redis chưa init (instance=null) — no-op");
    return;
  }
  try {
    await r.set(rebuiltSentinelKey(userId), "1", "EX", SENTINEL_TTL_SECONDS);
  } catch (err) {
    console.error("[feed-rebuild] sentinel failed:", err);
  }
};

export const getActiveFollowerIds = async (
  authorId: any,
): Promise<string[]> => {
  const cutoff = activeCutoff();
  const rows = await Follow.aggregate([
    { $match: { followeeId: ObjectId(String(authorId)) } },
    {
      $lookup: {
        from: "users",
        localField: "followerId",
        foreignField: "_id",
        as: "u",
        pipeline: [
          { $match: { lastActiveAt: { $gte: cutoff } } },
          { $project: { _id: 1 } },
        ],
      },
    },
    { $match: { "u.0": { $exists: true } } },
    { $project: { _id: 0, followerId: 1 } },
  ]);
  return rows.map((r) => String(r.followerId));
};

export const fanoutPostToFollowers = async (params: {
  post: any;
  io?: any;
}): Promise<void> => {
  const { post } = params;
  if (!FEED_CONFIG.fanoutEnabled) return;

  const { CREATE, EDIT, REPOST } = PostConstants.ACTIONS;
  if (![CREATE, EDIT, REPOST].includes(post?.type)) return;

  const t0 = Date.now();
  const postId = String(post._id);

  if (post?.visibility === Constants.POST_VISIBILITY.ONLY_ME) {
    const durationMs = Date.now() - t0;
    console.log("[feed-fanout]", { postId, onlyMe: true, zadds: 0, durationMs });
    return;
  }

  const author: any = await User.findOne(
    { _id: post.authorId },
    { followersCount: 1 },
  ).lean();

  if ((author?.followersCount ?? 0) > FEED_CONFIG.celebrityThreshold) {
    const followers = author?.followersCount ?? 0;
    const durationMs = Date.now() - t0;
    console.log("[feed-fanout]", { postId, celebrity: true, followers, zadds: 0, durationMs });
    return;
  }

  const followerIds = await getActiveFollowerIds(post.authorId);
  await zAddPostForUsers(followerIds, postId, new Date(post.createdAt).getTime());

  if (FEED_CONFIG.socketEnabled && params.io && followerIds.length) {
    try {
      const sockets = await getAllSockets(params.io);
      const byUser = new Map<string, string>();
      for (const sk of sockets ?? []) {
        const d: any = sk?.data ?? sk;
        if (d?.userId) byUser.set(String(d.userId), String(d.id ?? sk.id));
      }
      let emitted = 0;
      const event = Route.POST + POST_PATH.NEW_FROM_FOLLOWEE;
      for (const uid of followerIds) {
        const socketId = byUser.get(String(uid));
        if (socketId) {
          params.io
            .to(socketId)
            .emit(event, { postId, authorId: String(post.authorId) });
          emitted++;
        }
      }
      console.log("[feed-socket]", {
        postId,
        online: emitted,
        followers: followerIds.length,
        socketScans: 1,
      });
    } catch (err) {
      console.error("[feed-socket] error", err);
    }
  }

  const durationMs = Date.now() - t0;
  console.log("[feed-fanout]", {
    postId,
    celebrity: false,
    followers: followerIds.length,
    zadds: followerIds.length,
    durationMs,
  });
};

const SOCKET_SENT_TTL_SECONDS = 3600;

export const socketSentKey = (postId: string): string =>
  `feed:fanout:socket-sent:${postId}`;

export type DispatchJobData = { postId: string; authorId?: string };

export type DispatchDeps = {
  loadPost?: (postId: string) => Promise<any>;
  loadAuthor?: (authorId: any) => Promise<any>;
  getFollowerIds?: (authorId: any) => Promise<string[]>;
  enqueueBatches?: (jobs: any[]) => Promise<unknown>;
  redis?: any;
};

const defaultEnqueueBatches = async (jobs: any[]): Promise<unknown> => {
  const { batchQueue } = await import("./queue.ts");
  return batchQueue.addBulk(jobs);
};

export const processDispatchJob = async (
  data: DispatchJobData,
  io?: any,
  deps: DispatchDeps = {},
): Promise<void> => {
  const t0 = Date.now();
  const postId = String(data.postId);

  const loadPost =
    deps.loadPost ?? ((id: string) => Post.findOne({ _id: id }).lean());
  const loadAuthor =
    deps.loadAuthor ??
    ((authorId: any) =>
      User.findOne({ _id: authorId }, { followersCount: 1 }).lean());
  const getFollowerIds = deps.getFollowerIds ?? getActiveFollowerIds;
  const enqueueBatches = deps.enqueueBatches ?? defaultEnqueueBatches;

  const post: any = await loadPost(postId);
  if (!post) {
    console.log("[feed-fanout]", { postId, missing: true, batches: 0, durationMs: Date.now() - t0 });
    return;
  }

  const { CREATE, EDIT, REPOST } = PostConstants.ACTIONS;
  if (![CREATE, EDIT, REPOST].includes(post?.type)) return;

  if (post?.visibility === Constants.POST_VISIBILITY.ONLY_ME) {
    const durationMs = Date.now() - t0;
    console.log("[feed-fanout]", { postId, onlyMe: true, zadds: 0, batches: 0, durationMs });
    return;
  }

  const author: any = await loadAuthor(post.authorId);

  if ((author?.followersCount ?? 0) > FEED_CONFIG.celebrityThreshold) {
    const followers = author?.followersCount ?? 0;
    const durationMs = Date.now() - t0;
    console.log("[feed-fanout]", { postId, celebrity: true, followers, zadds: 0, batches: 0, durationMs });
    return;
  }

  const followerIds = await getFollowerIds(post.authorId);
  const scoreMs = new Date(post.createdAt).getTime();
  const chunks = chunk(followerIds, BATCH_SIZE);
  if (chunks.length) {
    await enqueueBatches(
      chunks.map((c, i) => ({
        name: "fanout-batch",
        data: { postId, followerIds: c, scoreMs },
        opts: {
          jobId: `${postId}:batch:${i}`,
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: { count: 5000 },
          removeOnFail: { count: 5000 },
        },
      })),
    );
  }

  const sentKey = socketSentKey(postId);
  const r = deps.redis ?? getRedisInstance();
  const alreadySent = r ? await r.exists(sentKey) : 0;
  if (FEED_CONFIG.socketEnabled && io && followerIds.length && !alreadySent) {
    try {
      const sockets = await getAllSockets(io);
      const byUser = new Map<string, string>();
      for (const sk of sockets ?? []) {
        const d: any = sk?.data ?? sk;
        if (d?.userId) byUser.set(String(d.userId), String(d.id ?? sk.id));
      }
      let emitted = 0;
      const event = Route.POST + POST_PATH.NEW_FROM_FOLLOWEE;
      for (const uid of followerIds) {
        const socketId = byUser.get(String(uid));
        if (socketId) {
          io.to(socketId).emit(event, { postId, authorId: String(post.authorId) });
          emitted++;
        }
      }
      if (r) await r.set(sentKey, "1", "EX", SOCKET_SENT_TTL_SECONDS);
      console.log("[feed-socket]", {
        postId,
        online: emitted,
        followers: followerIds.length,
        socketScans: 1,
      });
    } catch (err) {
      console.error("[feed-socket] error", err);
    }
  }

  const durationMs = Date.now() - t0;
  console.log("[feed-fanout]", {
    postId,
    celebrity: false,
    followers: followerIds.length,
    batches: chunks.length,
    durationMs,
  });
};

export type BatchJobData = {
  postId: string;
  followerIds: string[];
  scoreMs: number;
};

export const processBatchJob = async ({
  postId,
  followerIds,
  scoreMs,
}: BatchJobData): Promise<void> => {
  await zAddPostForUsersOrThrow(followerIds, postId, scoreMs);
  console.log("[feed-fanout-batch]", { postId, completedAt: Date.now() });
};

export const rebuildUserFeedZset = async (userId: any): Promise<number> => {
  const uid = String(userId);

  const followeeRows = await Follow.aggregate([
    { $match: { followerId: ObjectId(uid) } },
    {
      $lookup: {
        from: "users",
        localField: "followeeId",
        foreignField: "_id",
        as: "u",
        pipeline: [
          {
            $match: {
              followersCount: { $not: { $gt: FEED_CONFIG.celebrityThreshold } },
            },
          },
          { $project: { _id: 1 } },
        ],
      },
    },
    { $match: { "u.0": { $exists: true } } },
    { $project: { _id: 0, followeeId: 1 } },
  ]);

  const { CREATE, EDIT, REPOST } = PostConstants.ACTIONS;
  const visibilityQuery = await buildVisibilityQuery(
    uid,
    followeeRows.map((r) => r.followeeId),
  );
  const posts: any[] = followeeRows.length
    ? await Post.find(
        {
          authorId: { $in: followeeRows.map((r) => r.followeeId) },
          type: { $in: [CREATE, EDIT, REPOST] },
          createdAt: { $gte: activeCutoff() },
          ...visibilityQuery,
        },
        { _id: 1, createdAt: 1 },
      )
        .sort({ createdAt: -1 })
        .limit(FEED_CONFIG.zsetMaxSize)
        .lean()
    : [];

  const entries = posts.map((p) => ({
    postId: String(p._id),
    scoreMs: new Date(p.createdAt).getTime(),
  }));

  await zReplaceUserFeed(uid, entries);
  if (entries.length === 0) await setRebuiltSentinel(uid);

  console.log("[feed-rebuild]", {
    userId: uid,
    entries: entries.length,
    sentinel: entries.length === 0,
  });
  return entries.length;
};

export const backfillFeedOnFollow = async (
  followerId: any,
  followeeId: any,
): Promise<void> => {
  if (!FEED_CONFIG.fanoutEnabled) return;

  const followerUid = String(followerId);
  if (!(await zExists(followerUid))) return;

  const followee: any = await User.findOne(
    { _id: followeeId },
    { followersCount: 1 },
  ).lean();
  if ((followee?.followersCount ?? 0) > FEED_CONFIG.celebrityThreshold) return;

  const { CREATE, EDIT, REPOST } = PostConstants.ACTIONS;
  const visibilityQuery = await buildVisibilityQuery(followerUid, [followeeId]);
  const posts: any[] = await Post.find(
    {
      authorId: followeeId,
      type: { $in: [CREATE, EDIT, REPOST] },
      createdAt: { $gte: activeCutoff() },
      ...visibilityQuery,
    },
    { _id: 1, createdAt: 1 },
  )
    .sort({ createdAt: -1 })
    .limit(FEED_CONFIG.zsetMaxSize)
    .lean();
  if (posts.length === 0) return;

  const entries = posts.map((p) => ({
    postId: String(p._id),
    scoreMs: new Date(p.createdAt).getTime(),
  }));
  await zAddPostsForUser(followerUid, entries);
};

export const removeFeedOnUnfollow = async (
  followerId: any,
  followeeId: any,
): Promise<void> => {
  if (!FEED_CONFIG.fanoutEnabled) return;

  const { CREATE, EDIT, REPOST } = PostConstants.ACTIONS;
  const posts: { _id: unknown }[] = await Post.find(
    {
      authorId: followeeId,
      type: { $in: [CREATE, EDIT, REPOST] },
      createdAt: { $gte: activeCutoff() },
    },
    { _id: 1 },
  ).lean();
  if (posts.length === 0) return;

  await zRemovePostsForUser(
    String(followerId),
    posts.map((p) => String(p._id)),
  );
};
