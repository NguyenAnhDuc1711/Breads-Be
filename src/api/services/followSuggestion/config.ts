import { FEED_CONFIG, int } from "../feed/config.ts";

export const FOLLOW_SUGGESTION_CONFIG = Object.freeze({
  mutualFriendWeight: int(
    process.env.FOLLOW_SUGGESTION_MUTUAL_FRIEND_WEIGHT,
    10,
    "FOLLOW_SUGGESTION_MUTUAL_FRIEND_WEIGHT",
  ),
  categoryOverlapWeight: int(
    process.env.FOLLOW_SUGGESTION_CATEGORY_OVERLAP_WEIGHT,
    3,
    "FOLLOW_SUGGESTION_CATEGORY_OVERLAP_WEIGHT",
  ),
  topN: int(process.env.FOLLOW_SUGGESTION_TOP_N, 50, "FOLLOW_SUGGESTION_TOP_N"),
  workerConcurrency: int(
    process.env.FOLLOW_SUGGESTION_WORKER_CONCURRENCY,
    5,
    "FOLLOW_SUGGESTION_WORKER_CONCURRENCY",
  ),
  enabled: process.env.FOLLOW_SUGGESTION_ENABLED !== "false",
  lockTtlSeconds: int(
    process.env.FOLLOW_SUGGESTION_LOCK_TTL_SECONDS,
    1800,
    "FOLLOW_SUGGESTION_LOCK_TTL_SECONDS",
  ),
  refreshCronSchedule: process.env.FOLLOW_SUGGESTION_REFRESH_CRON_SCHEDULE || "0 */6 * * *",
  activeWindowDays: FEED_CONFIG.activeWindowDays,
});

console.log("[follow-suggestion-config]", FOLLOW_SUGGESTION_CONFIG);
