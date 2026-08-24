// Fixed (non-random) dataset for the NFR-1 response-size measurement
// (epic lean-api-response, task 021). See test/response-size-measure.js.
//
// These are REAL _ids pinned from the local dev MongoDB ("Breads" db,
// mongodb://127.0.0.1:27017/Breads) — not freshly-seeded fixture data. Task
// 010's TEST-1 risk was random CONTENT length varying between runs
// (src/api/seed/generatePosts.ts uses faker); pinning exact _ids sidesteps
// that entirely, because the stored documents for these _ids don't change
// between the OFF and ON run — only the response-filter flag does. This
// also avoids writing new rows into a shared local dev DB that other
// concurrent worktree-agents may also be using.
//
// FIXED_AUTHOR_ID has >=25 own PUBLIC-visibility, non-deleted, non-reply,
// non-repost posts — captured 2026-08-24 via the real `GET /api/v1/posts/`
// endpoint (`filter[page]=user`, anonymous viewer, page=1, limit=25,
// no `filter[value]` -> default type $nin [reply, repost]).
export const FIXED_AUTHOR_ID = "6a6c4e933438b8badc1bffa9";

// Expected result of that exact feed query, captured once and pinned here.
// The measurement script re-queries live (schema/query used by
// getPostsIdByFilter's USER branch hasn't changed) and compares the
// returned _id set against this list before trusting the byte counts —
// if another process has since inserted/deleted a post for this author,
// the set won't match and the script aborts instead of reporting a
// silently-invalid "fixed dataset" comparison.
export const FEED_POST_IDS = [
  "6a6c52ce896857f0e2f02c87",
  "6a6c52ce896857f0e2f02c8e",
  "6a6c52ce896857f0e2f02c67",
  "6a6c52ce896857f0e2f02c73",
  "6a6c52ce896857f0e2f02c7f",
  "6a6c52ce896857f0e2f02c6e",
  "6a6c52ce896857f0e2f02c7d",
  "6a6c52ce896857f0e2f02c8a",
  "6a840989796cfe1a7b2df28f",
  "6a83c9fa9022f3af35d410a2",
  "6a6c52ce896857f0e2f02c8c",
  "6a6c52ce896857f0e2f02c6b",
  "6a6c52ce896857f0e2f02c8d",
  "6a6c52ce896857f0e2f02c96",
  "670e244a45025dd3faa59fac",
  "66ff0c0f98f475a4b2e72593",
  "66ff0c0f98f475a4b2e7258a",
  "66ff0c0f98f475a4b2e72551",
  "66ff0c0f98f475a4b2e7253c",
  "66ff0c0f98f475a4b2e7253d",
  "66ff0c0f98f475a4b2e7253e",
  "66ff0c0f98f475a4b2e7253f",
  "66ff0c0f98f475a4b2e72540",
  "66ff0c0f98f475a4b2e72548",
  "66ff0c0f98f475a4b2e7252b",
];

// One post representative of the typical case (has content + media, all
// other optional fields empty/default) — used for the `GET post detail`
// measurement.
export const DETAIL_POST_ID = "6a6c4f713438b8badc56f4ff";

export const DEFAULT_MONGO_URI = "mongodb://127.0.0.1:27017/Breads";
