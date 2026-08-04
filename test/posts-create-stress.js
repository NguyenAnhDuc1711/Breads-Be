import http from "k6/http";
import { check, sleep } from "k6";
import exec from "k6/execution";
import { buildSummaryFiles } from "./lib/handle-summary.js";

// Baseline k6 load test for POST /api/posts/create (createPost) — captured
// BEFORE fan-out-on-write (task 021) exists, with FEED_FANOUT_ENABLED=false.
// This is the ONLY "before" data point for NFR-2's
// "p95 createPost after fan-out <= baseline * 1.10" comparison — it cannot
// be recaptured once fan-out code ships. See .ccpm/epics/feed-ranking-fanout/020.md.
//
// Override at run time, e.g.:
//   docker run --rm -i --network host -w /test \
//     -e BASE_URL=http://localhost:8090 -e JWT=... -e USER_ID=... \
//     -v "$(pwd)/test:/test" grafana/k6 run /test/posts-create-stress.js
//
// On Docker Desktop (Mac) without --network host, use:
//   -e BASE_URL=http://host.docker.internal:8090
//
// -w /test sets the container's CWD so reports land in the mounted
// test/results folder (see RESULTS_DIR below).
const TEST_NAME = "posts-create";
const BASE_URL = __ENV.BASE_URL || "http://host.docker.internal:8080";
const USER_ID = __ENV.USER_ID || "66fa65b4775c617545634c99";
const JWT =
  __ENV.JWT ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI2NmZhNjViNDc3NWM2MTc1NDU2MzRjOTkiLCJpYXQiOjE3ODU0ODA2NjgsImV4cCI6MTc4Njc3NjY2OH0.cSHZ8RA4qG5j_PVo7OoGXPtWLJXIRDgo3CUWm3n-Ilg";
// k6's default per-request timeout is 60s; override with -e REQUEST_TIMEOUT=120s
const REQUEST_TIMEOUT = __ENV.REQUEST_TIMEOUT || "600s";

// Single level (20 VUs) — kept as a list + empty-condition thresholds so
// k6 still emits the http_reqs/http_req_duration/http_req_failed submetrics
// in the summary (k6 only surfaces submetrics a threshold references),
// matching the format posts-all-stress.js uses and that build-history.js
// parses, even though there's only one level here.
const VU_LEVELS = [20];
const levelThresholds = {};
for (const level of VU_LEVELS) {
  levelThresholds[`http_reqs{vu_level:${level}}`] = [];
  levelThresholds[`http_req_duration{vu_level:${level}}`] = [];
  levelThresholds[`http_req_failed{vu_level:${level}}`] = [];
}

export const options = {
  scenarios: {
    create: {
      executor: "constant-vus",
      vus: 20,
      duration: "60s",
      gracefulStop: "30s",
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
    "Accept-Language": "en-US,en;q=0.9,vi;q=0.8",
    "Cache-Control": "no-cache",
    "Content-Type": "application/json",
    Origin: "http://localhost:3000",
    Referer: "http://localhost:3000/",
  },
  cookies: {
    jwt: JWT,
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

  // createPost (post.controller.ts:22-53) rejects with 400 if content/media/
  // survey/parentPost/quote/files are ALL empty, and 400s if content.length
  // > 500 — so content must be non-empty and short. media/survey/usersTag/
  // links/files must be arrays (controller calls .length/.map on them
  // unconditionally), not omitted/undefined.
  const payload = JSON.stringify({
    authorId: USER_ID,
    content: `k6 stress post ${__VU}-${__ITER}-${Date.now()}`,
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
