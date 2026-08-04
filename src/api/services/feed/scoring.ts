import { FEED_CONFIG } from "./config.ts";

/**
 * Pure, I/O-free scoring functions for the "For You" feed (FR-2/FR-3).
 *
 * `hotScore` is intentionally never persisted (AD-2): it is recomputed on every
 * read from `FEED_CONFIG` + the post's raw `engagementScore`, so a post silently
 * decays in rank purely by the passage of time, with zero writes.
 */

/**
 * Floors `nowMs` to the start of its `bucketSeconds` window so that repeated
 * requests within the same window (e.g. paginating) score against an identical
 * `now`, keeping pagination stable (AD-4).
 */
export const bucketedNow = (
  nowMs: number,
  bucketSeconds: number = FEED_CONFIG.scoreBucketSeconds
): number => {
  if (bucketSeconds <= 0) return nowMs;
  return Math.floor(nowMs / 1000 / bucketSeconds) * bucketSeconds * 1000;
};

/**
 * Time-decayed engagement score. `base` is coerced via `Number(x) || 0` BEFORE
 * clamping: `Math.max(0, undefined)` is `NaN`, not `0`, and `NaN` inside an
 * `Array.sort` comparator produces silently arbitrary ordering with no thrown
 * error. Posts created before the engagementScore backfill (or any other edge
 * case where the field is missing/garbage) must still score as `0`, not `NaN`.
 */
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

/**
 * Category-match relevance, ported as-is from the old `$filter` + `$in` + `*15`
 * aggregation stage in `getForYouPostsId`. `String(...)` is required: both
 * `postCategories` and `userCatesCare` are arrays of `ObjectId`, and `===`
 * between two distinct `ObjectId` instances is always `false`.
 */
export const relevanceScore = (
  postCategories: any[] = [],
  userCatesCare: any[] = []
): number => {
  if (!postCategories?.length || !userCatesCare?.length) return 0;
  const care = new Set(userCatesCare.map(String));
  return postCategories.filter((c) => care.has(String(c))).length * 15;
};

/** Blends relevance and time-decayed hotness per `FEED_CONFIG.{alpha,beta}`. */
export const finalScore = (
  post: { categories?: any[]; engagementScore?: unknown; createdAt: string | number | Date },
  userCatesCare: any[],
  nowMs: number
): number =>
  FEED_CONFIG.alpha * relevanceScore(post.categories, userCatesCare) +
  FEED_CONFIG.beta * hotScore(post.engagementScore, new Date(post.createdAt).getTime(), nowMs);

/**
 * Sorts candidates by `finalScore` desc with a total-order tie-break
 * (`createdAt` desc, then `_id` asc) so equal-score posts get a deterministic
 * order regardless of input order or sort algorithm — required for pagination
 * to never duplicate/skip posts across pages (SC-11).
 *
 * `finalScore` is computed once per post (decorate-sort-undecorate), not
 * inside the comparator, to avoid O(n log n) calls to `Math.exp`.
 */
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
