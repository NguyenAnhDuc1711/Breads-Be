import http from "k6/http";
import { check, sleep } from "k6";
import exec from "k6/execution";
import { buildSummaryFiles } from "./lib/handle-summary.js";

// Override at run time, e.g.:
//   docker run --rm -i --network host -w /test \
//     -e BASE_URL=http://localhost:8080 -e JWT=... -e USER_ID=... \
//     -v "$(pwd)/test:/test" grafana/k6 run /test/posts-all-stress.js
//
// On Docker Desktop (Mac) without --network host, use:
//   -e BASE_URL=http://host.docker.internal:8080
//
// -w /test sets the container's CWD so reports land in the mounted
// test/results folder (see RESULTS_DIR below).
const TEST_NAME = "posts-all-stress";
const BASE_URL = __ENV.BASE_URL || "http://host.docker.internal:8080";
const USER_ID = __ENV.USER_ID || "66fa65b4775c617545634c99";
const JWT =
  __ENV.JWT ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI2NmZhNjViNDc3NWM2MTc1NDU2MzRjOTkiLCJpYXQiOjE3ODU0ODA2NjgsImV4cCI6MTc4Njc3NjY2OH0.cSHZ8RA4qG5j_PVo7OoGXPtWLJXIRDgo3CUWm3n-Ilg";
// k6's default per-request timeout is 60s; override with -e REQUEST_TIMEOUT=120s
const REQUEST_TIMEOUT = __ENV.REQUEST_TIMEOUT || "600s";

// Must match (or bucket up to) the `target` values in options.stages below.
// Requests get tagged with the active VU count at send time (vu_level), and
// each level below is registered as a threshold with an empty condition list
// purely so k6 includes its http_reqs/http_req_duration/http_req_failed
// submetrics in the end-of-test summary (k6 only surfaces submetrics that a
// threshold references) — giving a per-concurrency-level breakdown of
// throughput and error rate, instead of one number pooled over the whole run.
const VU_LEVELS = [10, 50, 150, 300];
const levelThresholds = {};
for (const level of VU_LEVELS) {
  levelThresholds[`http_reqs{vu_level:${level}}`] = [];
  levelThresholds[`http_req_duration{vu_level:${level}}`] = [];
  levelThresholds[`http_req_failed{vu_level:${level}}`] = [];
}

export const options = {
  scenarios: {
    stress: {
      executor: "ramping-vus",
      // startVUs must be >= 1: ramping from 0 with a small first-stage
      // target (e.g. 1) makes k6 defer spinning up that VU until near the
      // end of the stage's duration, so it never gets a chance to send a
      // request before the stage ends (0 http_reqs, all metrics n/a).
      startVUs: 1,
      // This endpoint takes ~30-90s per request, so each "sustain" stage
      // needs to be long enough for VUs to get through more than one
      // iteration at that VU level, and gracefulStop/gracefulRampDown need
      // to be >= the slowest request so in-flight iterations aren't killed
      // mid-request when a stage transitions or the test ends.
      stages: [
        { duration: "1m", target: 10 },
        { duration: "5m", target: 50 },
        { duration: "1m", target: 150 },
        { duration: "5m", target: 150 },
        { duration: "1m", target: 300 },
        { duration: "5m", target: 300 },
        { duration: "1m", target: 0 },
      ],
      gracefulRampDown: "2m",
      gracefulStop: "2m",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.05"],
    http_req_duration: ["p(95)<90000"],
    ...levelThresholds,
  },
};

const params = {
  headers: {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9,vi;q=0.8",
    "Cache-Control": "no-cache",
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
  const url = `${BASE_URL}/api/posts/all?filter[page]=for_you&userId=${USER_ID}&isNewPage=true&page=1&limit=20`;

  const res = http.get(url, {
    ...params,
    tags: { vu_level: currentVuLevel() },
  });

  check(res, {
    "status is 200": (r) => r.status === 200,
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
