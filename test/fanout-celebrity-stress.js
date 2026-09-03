import http from "k6/http";
import { check, sleep } from "k6";
import exec from "k6/execution";
import { buildSummaryFiles } from "./lib/handle-summary.js";

const TEST_NAME = "fanout-celebrity";
const BASE_URL = __ENV.BASE_URL || "http://host.docker.internal:8080";
const AUTHOR_ID = __ENV.AUTHOR_ID || "671ee34db863a9a7301732af";
const REQUEST_TIMEOUT = __ENV.REQUEST_TIMEOUT || "600s";

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

export function handleSummary(data) {
  return buildSummaryFiles(data, TEST_NAME);
}
