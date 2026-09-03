import { FEED_CONFIG } from "./config.ts";

export const bucketedNow = (
  nowMs: number,
  bucketSeconds: number = FEED_CONFIG.scoreBucketSeconds
): number => {
  if (bucketSeconds <= 0) return nowMs;
  return Math.floor(nowMs / 1000 / bucketSeconds) * bucketSeconds * 1000;
};

export const hotScore = (
  engagementScore: unknown,
  createdAtMs: number,
  nowMs: number
): number => {
  const base = Math.max(0, Number(engagementScore) || 0);
  const ageHours = Math.max(0, (nowMs - createdAtMs) / 3_600_000);
  const lambda = Math.LN2 / FEED_CONFIG.halfLifeHours;
  return base * Math.exp(-lambda * ageHours);
};

export const relevanceScore = (
  postCategories: any[] = [],
  userCatesCare: any[] = []
): number => {
  if (!postCategories?.length || !userCatesCare?.length) return 0;
  const care = new Set(userCatesCare.map(String));
  return postCategories.filter((c) => care.has(String(c))).length * 15;
};

export const finalScore = (
  post: { categories?: any[]; engagementScore?: unknown; createdAt: string | number | Date },
  userCatesCare: any[],
  nowMs: number
): number =>
  FEED_CONFIG.alpha * relevanceScore(post.categories, userCatesCare) +
  FEED_CONFIG.beta * hotScore(post.engagementScore, new Date(post.createdAt).getTime(), nowMs);

export const rankCandidates = <
  T extends { _id: unknown; categories?: any[]; engagementScore?: unknown; createdAt: string | number | Date }
>(
  posts: T[],
  userCatesCare: any[],
  nowMs: number
): T[] =>
  posts
    .map((p) => ({ p, s: finalScore(p, userCatesCare, nowMs) }))
    .sort(
      (a, b) =>
        b.s - a.s ||
        new Date(b.p.createdAt).getTime() - new Date(a.p.createdAt).getTime() ||
        String(a.p._id).localeCompare(String(b.p._id))
    )
    .map(({ p }) => p);
