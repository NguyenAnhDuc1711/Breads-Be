import PostConstants from "../../../Breads-Shared/Constants/PostConstants.js";
import { getRedisInstance } from "../../../dbs/redis.ts";
import { ObjectId } from "../../../utils/index.js";
import Follow from "../../models/follow.model.js";
import Post from "../../models/post.model.js";
import User from "../../models/user.model.js";
import { buildVisibilityQuery, getCandidatesFromMongo } from "../post.js";
import { FEED_CONFIG } from "./config.ts";
import { accountDiscovery, discoveryBatchSize, getDiscoveryCandidates, planDiscovery } from "./discovery.ts";
import { rebuildUserFeedZset, rebuiltSentinelKey } from "./fanout.ts";
import { bucketedNow, rankCandidates } from "./scoring.ts";
import { zExists, zRevRangeTop } from "./zset.ts";

const REDIS_READ_TIMEOUT_MS = 200;

const withTimeout = <T>(p: Promise<T>, fallback: T): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((resolve) =>
      setTimeout(() => resolve(fallback), REDIS_READ_TIMEOUT_MS),
    ),
  ]);

const sentinelExists = async (userId: string): Promise<boolean> => {
  const r = getRedisInstance();
  if (!r) return false;
  try {
    return (await r.exists(rebuiltSentinelKey(userId))) === 1;
  } catch (err) {
    console.error("[feed] sentinelExists failed:", err);
    return false;
  }
};

export const getForYouFeed = async ({
  userId,
  viewerId = null,
  skip = 0,
  limit = 20,
  followeeIds = null,
}: {
  userId: any;
  viewerId?: any;
  skip?: number | string;
  limit?: number | string;
  followeeIds?: any[] | null;
}): Promise<any[]> => {
  const skipNum = Number(skip) || 0;
  const limitNum = Number(limit) || 20;
  const t0 = Date.now();
  try {
    const user: any = await User.findOne(
      { _id: ObjectId(userId) },
      { catesCare: 1 },
    ).lean();
    const userCatesCare = user?.catesCare ?? [];

    const visibilityQuery = await buildVisibilityQuery(viewerId, followeeIds);

    let source = "";
    let poolIds: string[] = [];
    if (FEED_CONFIG.fanoutEnabled) {
      poolIds = await withTimeout(
        zRevRangeTop(String(userId), FEED_CONFIG.candidatePool),
        [],
      );
      if (!poolIds.length) {
        const exists = await withTimeout(zExists(String(userId)), false);
        if (!exists) {
          const recentlyRebuilt = await withTimeout(
            sentinelExists(String(userId)),
            false,
          );
          if (!recentlyRebuilt) {
            const n = await rebuildUserFeedZset(userId);
            if (n > 0) {
              poolIds = await withTimeout(
                zRevRangeTop(String(userId), FEED_CONFIG.candidatePool),
                [],
              );
            }
          }
        }
      }
      if (poolIds.length) source = "zset";
    }

    const celebRows: { followeeId: any }[] = await Follow.aggregate([
      { $match: { followerId: ObjectId(userId) } },
      {
        $lookup: {
          from: "users",
          localField: "followeeId",
          foreignField: "_id",
          as: "u",
          pipeline: [
            { $match: { followersCount: { $gt: FEED_CONFIG.celebrityThreshold } } },
            { $project: { _id: 1 } },
          ],
        },
      },
      { $match: { "u.0": { $exists: true } } },
      { $project: { _id: 0, followeeId: 1 } },
    ]);
    const celebrityIds = celebRows.map((r) => r.followeeId);
    if (celebrityIds.length) {
      const { CREATE, EDIT, REPOST } = PostConstants.ACTIONS;
      const celebPosts: { _id: unknown }[] = await Post.find(
        {
          authorId: { $in: celebrityIds },
          type: { $in: [CREATE, EDIT, REPOST] },
          createdAt: {
            $gte: new Date(Date.now() - FEED_CONFIG.activeWindowDays * 86400_000),
          },
          ...visibilityQuery,
        },
        { _id: 1 },
      )
        .sort({ createdAt: -1 })
        .limit(FEED_CONFIG.candidatePool)
        .lean();
      if (celebPosts.length) {
        poolIds = poolIds.concat(celebPosts.map((p) => String(p._id)));
        source = source === "zset" ? "zset+celebrity" : "celebrity";
      }
    }

    if (!poolIds.length) {
      poolIds = (
        await getCandidatesFromMongo({
          userId,
          viewerId,
          followeeIds,
          limit: FEED_CONFIG.candidatePool,
        })
      ).map(String);
      source = "mongo-fallback";
    }
    poolIds = Array.from(new Set(poolIds));

    const basePoolSize = poolIds.length;

    const plan = planDiscovery({
      enabled: FEED_CONFIG.discoveryEnabled,
      source,
      basePoolSize,
      skip: skipNum,
      limit: limitNum,
      batch: discoveryBatchSize(),
      maxSkip: FEED_CONFIG.discoveryMaxSkip,
    });

    let discoveryIds: string[] = [];
    if (plan.n > 0) {
      try {
        discoveryIds = await getDiscoveryCandidates({
          userId,
          poolIds,
          visibilityQuery,
          offset: plan.offset,
          n: plan.n,
        });
      } catch (err) {
        console.error("[feed] discovery failed:", err);
      }
    }
    if (plan.mode === "blend" && discoveryIds.length) {
      poolIds = poolIds.concat(discoveryIds);
    }

    const candidateMs = Date.now() - t0;

    let hydrateMs: number | null = null;
    let page: any[];

    if (plan.mode === "extend") {
      page = discoveryIds;
    } else {
      const t1 = Date.now();
      const posts: any[] = await Post.find(
        { _id: { $in: poolIds.map((id) => ObjectId(id)) }, ...visibilityQuery },
        { _id: 1, engagementScore: 1, categories: 1, createdAt: 1 },
      ).lean();
      hydrateMs = Date.now() - t1;

      const nowMs = bucketedNow(Date.now(), FEED_CONFIG.scoreBucketSeconds);
      page = rankCandidates(posts, userCatesCare, nowMs)
        .slice(skipNum, skipNum + limitNum)
        .map(({ _id }) => _id);
    }

    const { shown, bestRank, avgRank } = accountDiscovery(page, discoveryIds);

    console.log("[feed]", {
      userId: String(userId),
      source,
      poolSize: poolIds.length,
      returned: page.length,
      candidateMs,
      hydrateMs,
      discoveryMode: plan.mode,
      discoveryFetched: discoveryIds.length,
      discoveryShown: shown,
      discoveryBestRank: bestRank,
      discoveryAvgRank: avgRank,
    });
    return page;
  } catch (err) {
    console.error("[feed] ERROR", err);
    return [];
  }
};
