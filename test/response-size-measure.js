#!/usr/bin/env node

/**
 * NFR-1 response-size measurement (epic lean-api-response, task 021).
 *
 * Measures real Content-Length for `GET feed` (25 posts) and
 * `GET post detail`, once with POST_RESPONSE_FIELD_FILTER_ENABLED=false
 * (baseline) and once with it =true (after), on the SAME fixed post_id
 * dataset (test/fixtures/response-size-fixed-ids.js) — never randomly
 * seeded data, per plan-review TEST-1.
 *
 * The flag is read once at module load and frozen (`Object.freeze` in
 * src/api/services/config.ts) — flipping it needs a process restart, not a
 * live toggle. This script spawns the real `npx tsx src/server.ts` process
 * TWICE (OFF, then ON), each a fully separate Node process, against the
 * local dev MongoDB.
 *
 * Prerequisites:
 *   - MongoDB running at MONGO_URI (default: mongodb://127.0.0.1:27017/Breads)
 *     containing the fixed author's posts (real local dev seed data — see
 *     the fixture file for provenance).
 *   - Redis running at REDIS_HOST/REDIS_PORT (default: localhost:6379).
 *   - Port 8098 (or $PORT) free on localhost.
 *
 * Usage:
 *   node test/response-size-measure.js
 *
 * Output: test/results/{timestamp}__post-response-size.json + .txt
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MONGO_URI,
  DETAIL_POST_ID,
  FEED_POST_IDS,
  FIXED_AUTHOR_ID,
} from "./fixtures/response-size-fixed-ids.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const RESULTS_DIR = path.join(__dirname, "results");

const PORT = Number(process.env.PORT) || 8098;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const MONGO_URI = process.env.MONGO_URI || DEFAULT_MONGO_URI;
const READY_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 8_000;
const THRESHOLD_PCT = 20;

const feedParams = new URLSearchParams();
feedParams.set("filter[page]", "user");
feedParams.set("userId", FIXED_AUTHOR_ID);
feedParams.set("page", "1");
feedParams.set("limit", String(FEED_POST_IDS.length));
const FEED_URL = `${BASE_URL}/api/v1/posts/?${feedParams.toString()}`;
const DETAIL_URL = `${BASE_URL}/api/v1/posts/${DETAIL_POST_ID}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startServer(flagEnabled) {
  const child = spawn("npx", ["tsx", "src/server.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      MONGO_URI,
      JWT_SECRET: process.env.JWT_SECRET || "response-size-measure-script",
      POST_RESPONSE_FIELD_FILTER_ENABLED: flagEnabled ? "true" : "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logLines = [];
  child.stdout.on("data", (d) => logLines.push(d.toString()));
  child.stderr.on("data", (d) => logLines.push(d.toString()));
  return { child, logLines };
}

// Polls `/metrics` (mounted before any DB-touching route) until the server
// accepts connections — any HTTP response means it's up, we don't care
// about this endpoint's own status code.
async function waitUntilReady(deadline) {
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE_URL}/metrics`);
      return true;
    } catch {
      // ECONNREFUSED while still booting — keep polling.
    }
    await sleep(300);
  }
  return false;
}

async function stopServer(child) {
  if (child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    sleep(SHUTDOWN_TIMEOUT_MS).then(() => false),
  ]);
  if (!exited) child.kill("SIGKILL");
}

async function measureOnce(url) {
  const res = await fetch(url);
  const text = await res.text();
  const contentLengthHeader = res.headers.get("content-length");
  const bytes = contentLengthHeader
    ? Number(contentLengthHeader)
    : Buffer.byteLength(text, "utf8");
  return { status: res.status, bytes, body: JSON.parse(text) };
}

async function runPass(label, flagEnabled) {
  console.error(`[measure] starting server (flag ${flagEnabled ? "ON" : "OFF"})...`);
  const { child, logLines } = startServer(flagEnabled);

  try {
    const ready = await waitUntilReady(Date.now() + READY_TIMEOUT_MS);
    if (!ready) {
      throw new Error(
        `Server did not become ready within ${READY_TIMEOUT_MS}ms.\n--- last logs ---\n${logLines.slice(-40).join("")}`,
      );
    }

    const feed = await measureOnce(FEED_URL);
    if (feed.status !== 200) {
      throw new Error(`Feed request failed: HTTP ${feed.status}\n${JSON.stringify(feed.body)}`);
    }
    const feedIds = (feed.body.metadata || []).map((p) => p._id);
    const expectedSet = new Set(FEED_POST_IDS);
    const gotSet = new Set(feedIds);
    const setsMatch =
      feedIds.length === FEED_POST_IDS.length &&
      expectedSet.size === gotSet.size &&
      [...expectedSet].every((id) => gotSet.has(id));
    if (!setsMatch) {
      throw new Error(
        `Feed returned a different post set than the pinned fixture (dataset drifted — ` +
          `another process likely inserted/deleted a post for author ${FIXED_AUTHOR_ID} between runs). ` +
          `Expected ${FEED_POST_IDS.length} ids: ${JSON.stringify(FEED_POST_IDS)}\n` +
          `Got ${feedIds.length} ids: ${JSON.stringify(feedIds)}`,
      );
    }

    const detail = await measureOnce(DETAIL_URL);
    if (detail.status !== 200) {
      throw new Error(`Detail request failed: HTTP ${detail.status}\n${JSON.stringify(detail.body)}`);
    }
    if (detail.body?.metadata?._id !== DETAIL_POST_ID) {
      throw new Error(
        `Detail response _id mismatch: expected ${DETAIL_POST_ID}, got ${detail.body?.metadata?._id}`,
      );
    }

    console.error(
      `[measure] ${label}: feed=${feed.bytes} bytes (${feedIds.length} posts), detail=${detail.bytes} bytes`,
    );

    return { feedBytes: feed.bytes, detailBytes: detail.bytes, feedCount: feedIds.length };
  } finally {
    await stopServer(child);
  }
}

const pctReduction = (before, after) => ((before - after) / before) * 100;

async function main() {
  const off = await runPass("OFF (baseline)", false);
  const on = await runPass("ON (after)", true);

  const feedPct = pctReduction(off.feedBytes, on.feedBytes);
  const detailPct = pctReduction(off.detailBytes, on.detailBytes);

  const report = {
    testName: "post-response-size",
    timestamp: new Date().toISOString(),
    thresholdPct: THRESHOLD_PCT,
    fixedDataset: {
      authorId: FIXED_AUTHOR_ID,
      feedPostIds: FEED_POST_IDS,
      feedPostCount: FEED_POST_IDS.length,
      detailPostId: DETAIL_POST_ID,
      mongoUri: MONGO_URI,
    },
    results: {
      feed: {
        endpoint: "GET /api/v1/posts/ (filter[page]=user, 25 posts)",
        bytesOff: off.feedBytes,
        bytesOn: on.feedBytes,
        reductionPct: Number(feedPct.toFixed(2)),
        meetsNfr1: feedPct >= THRESHOLD_PCT,
      },
      detail: {
        endpoint: "GET /api/v1/posts/:id",
        bytesOff: off.detailBytes,
        bytesOn: on.detailBytes,
        reductionPct: Number(detailPct.toFixed(2)),
        meetsNfr1: detailPct >= THRESHOLD_PCT,
      },
    },
  };

  mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = report.timestamp.replace(/[:.]/g, "-");
  const baseName = `${stamp}__post-response-size`;
  const jsonPath = path.join(RESULTS_DIR, `${baseName}.json`);
  const txtPath = path.join(RESULTS_DIR, `${baseName}.txt`);

  const text = [
    `Test:        post-response-size (NFR-1)`,
    `Timestamp:   ${report.timestamp}`,
    `Fixed author: ${FIXED_AUTHOR_ID}`,
    `Fixed feed post count: ${FEED_POST_IDS.length}`,
    `Fixed detail post: ${DETAIL_POST_ID}`,
    ``,
    `GET feed (25 posts):`,
    `  before (flag OFF): ${off.feedBytes} bytes`,
    `  after  (flag ON):  ${on.feedBytes} bytes`,
    `  reduction: ${report.results.feed.reductionPct}%  (target >=${THRESHOLD_PCT}%)  ${report.results.feed.meetsNfr1 ? "PASS" : "FAIL"}`,
    ``,
    `GET post detail:`,
    `  before (flag OFF): ${off.detailBytes} bytes`,
    `  after  (flag ON):  ${on.detailBytes} bytes`,
    `  reduction: ${report.results.detail.reductionPct}%  (target >=${THRESHOLD_PCT}%)  ${report.results.detail.meetsNfr1 ? "PASS" : "FAIL"}`,
    ``,
  ].join("\n");

  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(txtPath, text);

  console.log(text);
  console.log(`Report written to:\n  ${jsonPath}\n  ${txtPath}`);
}

main().catch((err) => {
  console.error("[measure] FATAL:", err.message || err);
  process.exit(1);
});
