// Mirror `src/api/services/feed/config.ts` (task 001/AD-5, AD-6, AD-7 — epic follow-suggestions).
// Dùng lại `int` từ feed/config.ts thay vì copy-paste helper (DRY, xem WARN-3 trong epic.md).
import { int } from "../feed/config.ts";

export const FOLLOW_SUGGESTION_CONFIG = Object.freeze({
  // W1 (AD-5) — trọng số mutual-friend trong công thức score = W1*mutualFriendCount +
  // W2*categoryOverlapCount.
  mutualFriendWeight: int(
    process.env.FOLLOW_SUGGESTION_MUTUAL_FRIEND_WEIGHT,
    10,
    "FOLLOW_SUGGESTION_MUTUAL_FRIEND_WEIGHT",
  ),
  // W2 (AD-5).
  categoryOverlapWeight: int(
    process.env.FOLLOW_SUGGESTION_CATEGORY_OVERLAP_WEIGHT,
    3,
    "FOLLOW_SUGGESTION_CATEGORY_OVERLAP_WEIGHT",
  ),
  // Số candidate tối đa giữ lại/trả về mỗi user (FR-1).
  topN: int(process.env.FOLLOW_SUGGESTION_TOP_N, 50, "FOLLOW_SUGGESTION_TOP_N"),
  // Concurrency cho BullMQ worker (task 010) — khai báo ở đây để worker/cron/backfill dùng chung
  // 1 nguồn, dù computeSuggestionsForUser (task 001) không tự đọc field này.
  workerConcurrency: int(
    process.env.FOLLOW_SUGGESTION_WORKER_CONCURRENCY,
    5,
    "FOLLOW_SUGGESTION_WORKER_CONCURRENCY",
  ),
  // Kill-switch (AD-6, mirror `FEED_CONFIG.fanoutEnabled`) — read-path (task 011) dùng để luôn
  // route về fallback aggregation khi tắt, bất kể cache có gì.
  enabled: process.env.FOLLOW_SUGGESTION_ENABLED !== "false",
  // TTL cho lock cron/backfill overlap-guard (AD-7, task 012) — Redis `SET NX EX`.
  lockTtlSeconds: int(
    process.env.FOLLOW_SUGGESTION_LOCK_TTL_SECONDS,
    1800,
    "FOLLOW_SUGGESTION_LOCK_TTL_SECONDS",
  ),
});

console.log("[follow-suggestion-config]", FOLLOW_SUGGESTION_CONFIG);
