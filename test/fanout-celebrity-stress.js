import http from "k6/http";
import { check, sleep } from "k6";
import exec from "k6/execution";
import { buildSummaryFiles } from "./lib/handle-summary.js";

// Stress test for fan-out-on-write (fanout.ts: fanoutPostToFollowers) under a
// near-celebrity author — i.e. the largest follower count that STILL goes
// through the push-on-write path instead of being skipped.
//
// fanoutPostToFollowers() returns 0 ZADDs (no-op) for any author whose
// followersCount > FEED_CONFIG.celebrityThreshold (default 50,000, see
// src/api/services/feed/config.ts) — those authors are merged into
// followers' feeds at READ time instead (discovery.ts). So testing against
// one of the seeded mega-celebrities (300k-2M, see seedCelebrityFollows.ts)
// would exercise almost nothing here.
//
// Default AUTHOR_ID below is "671ee34db863a9a7301732af", seeded with exactly
// 50,000 followers by `npm run seed:celebrity-follows` — the biggest author
// that still triggers the full push path. Each post from this author makes
// fanoutPostToFollowers():
//   - 1 Mongo aggregate ($lookup across ~50k Follow docs, filtered by
//     followers' lastActiveAt) in getActiveFollowerIds()
//   - ~25 Redis pipelines of 2000 followers each (zset.ts BATCH_SIZE), each
//     follower getting ZADD + ZREMRANGEBYRANK + EXPIRE — ~150k Redis commands
//     for a single POST /api/posts/create call.
//
// IMPORTANT — fan-out is fire-and-forget (post.controller.ts calls
// fanoutPostToFollowers() WITHOUT await, wrapped in .catch()). The HTTP
// response returns as soon as the Post doc is written, before any ZADD
// happens. So http_req_duration here reflects the create-post write path,
// NOT the fan-out cost. To see the fan-out cost itself:
//   - tail the app's stdout/logs for "[feed-fanout]" lines (durationMs,
//     zadds, matches the postId this script logs to console)
//   - watch Redis/Mongo metrics (see command list above) around the same
//     wall-clock window as each request
//
// Run (from repo root, requires the stack from docker-compose.yml running):
//   docker run --rm -i --network host -w /test \
//     -e BASE_URL=http://localhost:8080 -e AUTHOR_ID=671ee34db863a9a7301732af \
//     -v "$(pwd)/test:/test" grafana/k6 run /test/fanout-celebrity-stress.js
//
// On Docker Desktop (Mac) without --network host, use:
//   -e BASE_URL=http://host.docker.internal:8080
//
// Prerequisites against the target MongoDB:
//   1. `npm run seed:celebrity-follows` — so AUTHOR_ID has followers.
//   2. `npm run seed:activate-followers -- --followeeId=671ee34db863a9a7301732af`
//      — getActiveFollowerIds() in fanout.ts only fans out to followers whose
//      `lastActiveAt` is within the last `activeWindowDays` (7) days. Seeded
//      followers have no lastActiveAt at all, so without this step nearly
//      all 50k would be filtered out and the fan-out would look like a
//      near no-op regardless of raw follower count.
//
// Note: POST /api/posts/create has no protectRoute/auth middleware (see
// post.route.ts) — authorId is taken straight from the body, so no JWT is
// required for this script to work.
const TEST_NAME = "fanout-celebrity";
const BASE_URL = __ENV.BASE_URL || "http://host.docker.internal:8080";
const AUTHOR_ID = __ENV.AUTHOR_ID || "671ee34db863a9a7301732af";
const REQUEST_TIMEOUT = __ENV.REQUEST_TIMEOUT || "600s";

// Low VU levels on purpose: this simulates ONE near-celebrity account
// posting, so concurrency here stands in for "how many fan-outs are
// in flight for this author at once" (retries, rapid back-to-back posts),
// not a multi-tenant traffic pattern. Each single iteration already costs
// ~150k Redis commands + one large Mongo aggregate, so it doesn't take many
// VUs to see Redis/Mongo saturate.
const VU_LEVELS = [1, 2, 5, 10];
const levelThresholds = {};
for (const level of VU_LEVELS) {
  levelThresholds[`http_reqs{vu_level:${level}}`] = [];
  levelThresholds[`http_req_duration{vu_level:${level}}`] = [];
  levelThresholds[`http_req_failed{vu_level:${level}}`] = [];
}

export const options = {
  scenarios: {
    fanout: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "12s", target: 1 },
        { duration: "24s", target: 2 },
        { duration: "12s", target: 5 },
        { duration: "24s", target: 5 },
        { duration: "12s", target: 10 },
        { duration: "24s", target: 10 },
        { duration: "12s", target: 0 },
      ],
      gracefulRampDown: "10s",
      gracefulStop: "10s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.05"],
    http_req_duration: ["p(95)<5000"],
    ...levelThresholds,
  },
};

const params = {
  headers: {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    Origin: "http://localhost:3000",
    Referer: "http://localhost:3000/",
  },
  timeout: REQUEST_TIMEOUT,
};

function currentVuLevel() {
  const active = exec.instance.vusActive;
  for (const level of VU_LEVELS) {
    if (active <= level) return String(level);
  }
  return String(VU_LEVELS[VU_LEVELS.length - 1]);
}

export default function () {
  const url = `${BASE_URL}/api/posts/create`;

  const payload = JSON.stringify({
    authorId: AUTHOR_ID,
    content: `k6 fanout stress post ${__VU}-${__ITER}-${Date.now()}`,
    media: [],
    survey: [],
    usersTag: [],
    links: [],
    files: [],
    type: "create",
  });

  const res = http.post(url, payload, {
    ...params,
    tags: { vu_level: currentVuLevel() },
  });

  check(res, {
    "status is 2xx": (r) => r.status >= 200 && r.status < 300,
    "response has body": (r) => r.body && r.body.length > 0,
  });

  sleep(1);
}

// Writes a timestamped JSON + text report to RESULTS_DIR (default
// "./results", relative to the k6 process's CWD) on top of the normal
// stdout summary.
export function handleSummary(data) {
  return buildSummaryFiles(data, TEST_NAME);
}
