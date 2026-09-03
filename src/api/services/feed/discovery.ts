import { FEED_CONFIG } from "./config.ts";
import PostConstants from "../../../Breads-Shared/Constants/PostConstants.js";
import { ObjectId } from "../../../utils/index.js";
import Post from "../../models/post.model.js";

export const discoveryBatchSize = (): number =>
  Math.ceil(FEED_CONFIG.candidatePool * FEED_CONFIG.discoveryRatio);

export type DiscoveryPlan = {
  mode: "off" | "blend" | "extend";
  offset: number;
  n: number;
};

export const planDiscovery = ({
  enabled,
  source,
  basePoolSize,
  skip,
  limit,
  batch,
  maxSkip,
}: {
  enabled: boolean;
  source: string;
  basePoolSize: number;
  skip: number;
  limit: number;
  batch: number;
  maxSkip: number;
}): DiscoveryPlan => {
  const servablePool =
    source === "mongo-fallback" ? basePoolSize : basePoolSize + batch;

  if (!enabled) return { mode: "off", offset: 0, n: 0 };

  if (skip + limit > servablePool) {
    return {
      mode: "extend",
      offset: Math.min(batch + Math.max(0, skip - servablePool), maxSkip),
      n: limit,
    };
  }

  if (source === "mongo-fallback") return { mode: "off", offset: 0, n: 0 };

  return { mode: "blend", offset: 0, n: batch };
};

export const accountDiscovery = (
  page: unknown[],
  discoveryIds: string[]
): { shown: number; bestRank: number | null; avgRank: number | null } => {
  const discoverySet = new Set(discoveryIds.map(String));
  const ranks: number[] = [];
  page.forEach((id, i) => {
    if (discoverySet.has(String(id))) ranks.push(i + 1);
  });
  const shown = ranks.length;
  return {
    shown,
    bestRank: shown > 0 ? Math.min(...ranks) : null,
    avgRank: shown > 0 ? ranks.reduce((a, b) => a + b, 0) / shown : null,
  };
};

export const getDiscoveryCandidates = async ({
  userId,
  poolIds,
  visibilityQuery,
  offset,
  n,
}: {
  userId: any;
  poolIds: string[];
  visibilityQuery: Record<string, unknown>;
  offset: number;
  n: number;
}): Promise<string[]> => {
  const { CREATE, EDIT, REPOST } = PostConstants.ACTIONS;
  const rows: { _id: unknown }[] = await Post.find(
    {
      _id: { $nin: poolIds.map((id) => ObjectId(id)) },
      authorId: { $ne: ObjectId(userId) },
      type: { $in: [CREATE, EDIT, REPOST] },
      ...visibilityQuery,
    },
    { _id: 1 },
  )
    .sort({ engagementScore: -1, _id: -1 })
    .skip(offset)
    .limit(n)
    .lean();
  return rows.map((r) => String(r._id));
};
