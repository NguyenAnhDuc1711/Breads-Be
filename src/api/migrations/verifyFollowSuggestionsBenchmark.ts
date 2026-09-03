import dotenv from "dotenv";
import mongoose from "mongoose";
import { pathToFileURL } from "url";
import fs from "fs";
import path from "path";
import { performance } from "perf_hooks";
import User from "../models/user.model.js";
import FollowSuggestion from "../models/followSuggestion.model.js";
import { getUserToFollows } from "../controllers/user.controller.js";
import { FOLLOW_SUGGESTION_CONFIG } from "../services/followSuggestion/config.ts";
import { ObjectId } from "../../utils/index.js";

dotenv.config();

const DEFAULT_SAMPLE_SIZE = Number(process.env.FOLLOW_SUGGESTION_BENCHMARK_SAMPLE_SIZE) || 100;
const DEFAULT_TOP_N = 10;
const DEFAULT_OUTPUT_DIR = path.resolve(process.cwd(), "benchmark-results");

export interface FollowSuggestionBenchmarkOptions {
  sampleSize?: number;
  topN?: number;
  outputDir?: string;
}

export interface FollowSuggestionBenchmarkResult {
  timestamp: string;
  followSuggestionEnabled: boolean;
  sampleSize: number;
  latencyMs: {
    p50: number;
    p95: number;
    p99: number;
    min: number;
    max: number;
    avg: number;
  };
  precisionAt10: {
    evaluated: number;
    hits: number;
    ratio: number | null;
  };
  outputFile: string;
}

const round = (n: number, decimals = 2) => {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
};

const percentile = (sortedAsc: number[], p: number): number => {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.min(sortedAsc.length, Math.max(1, Math.ceil((p / 100) * sortedAsc.length)));
  return sortedAsc[rank - 1];
};

const pickSampleUserIds = async (n: number): Promise<string[]> => {
  const sampled = await User.aggregate([
    { $sample: { size: n } },
    { $project: { _id: 1 } },
  ]);
  return sampled.map((u: any) => String(u._id));
};

const measureLatencyForUser = async (userId: string, topN: number): Promise<number> => {
  const req = { query: { userId, page: "1", limit: String(topN) } } as any;
  const res = {
    status() {
      return this;
    },
    json() {
      return this;
    },
  } as any;

  const start = performance.now();
  await getUserToFollows(req, res);
  return performance.now() - start;
};

const measurePrecisionForUser = async (userId: string, topN: number): Promise<boolean | null> => {
  const doc = await FollowSuggestion.findOne({ userId: ObjectId(userId) }).lean();
  if (!doc || !doc.candidates || doc.candidates.length === 0) return null;
  const top = doc.candidates.slice(0, topN);
  return top.some((c: any) => (c.mutualFriendCount ?? 0) > 0);
};

export const runFollowSuggestionsBenchmark = async (
  options: FollowSuggestionBenchmarkOptions = {},
): Promise<FollowSuggestionBenchmarkResult> => {
  const sampleSize = options.sampleSize ?? DEFAULT_SAMPLE_SIZE;
  const topN = options.topN ?? DEFAULT_TOP_N;
  const outputDir = options.outputDir ?? DEFAULT_OUTPUT_DIR;

  const userIds = await pickSampleUserIds(sampleSize);
  if (userIds.length === 0) {
    throw new Error(
      "verifyFollowSuggestionsBenchmark: no users found in DB — seed data before running.",
    );
  }

  const latenciesMs: number[] = [];
  for (const userId of userIds) {
    latenciesMs.push(await measureLatencyForUser(userId, topN));
  }
  latenciesMs.sort((a, b) => a - b);

  let evaluated = 0;
  let hits = 0;
  for (const userId of userIds) {
    const hasHit = await measurePrecisionForUser(userId, topN);
    if (hasHit !== null) {
      evaluated += 1;
      if (hasHit) hits += 1;
    }
  }

  const timestamp = new Date().toISOString();
  const result: FollowSuggestionBenchmarkResult = {
    timestamp,
    followSuggestionEnabled: FOLLOW_SUGGESTION_CONFIG.enabled,
    sampleSize: userIds.length,
    latencyMs: {
      p50: round(percentile(latenciesMs, 50)),
      p95: round(percentile(latenciesMs, 95)),
      p99: round(percentile(latenciesMs, 99)),
      min: round(latenciesMs[0] ?? 0),
      max: round(latenciesMs[latenciesMs.length - 1] ?? 0),
      avg: round(latenciesMs.reduce((a, b) => a + b, 0) / latenciesMs.length),
    },
    precisionAt10: {
      evaluated,
      hits,
      ratio: evaluated > 0 ? round(hits / evaluated, 4) : null,
    },
    outputFile: "",
  };

  fs.mkdirSync(outputDir, { recursive: true });
  const fileName = `follow-suggestions-${timestamp.replace(/[:.]/g, "-")}.json`;
  const filePath = path.join(outputDir, fileName);
  result.outputFile = filePath;
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2));

  console.log("\n=== Follow Suggestions Benchmark ===");
  console.log(`timestamp:  ${result.timestamp}`);
  console.log(`kill-switch (FOLLOW_SUGGESTION_CONFIG.enabled): ${result.followSuggestionEnabled}`);
  console.log(`sample size: ${result.sampleSize} users, top-${topN}`);
  console.table({
    "P50 (ms)": result.latencyMs.p50,
    "P95 (ms)": result.latencyMs.p95,
    "P99 (ms)": result.latencyMs.p99,
    "min (ms)": result.latencyMs.min,
    "max (ms)": result.latencyMs.max,
    "avg (ms)": result.latencyMs.avg,
  });
  console.log(
    result.precisionAt10.ratio !== null
      ? `precision@10: ${hits}/${evaluated} users had >=1 candidate with mutualFriendCount>0 ` +
          `(${(result.precisionAt10.ratio * 100).toFixed(1)}%)`
      : "precision@10: no sampled user has a cached FollowSuggestion doc yet " +
          "(run cron/backfill — tasks 010/012/020 — first)",
  );
  console.log(`output written to: ${filePath}\n`);

  return result;
};

const main = async () => {
  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017");
  try {
    await runFollowSuggestionsBenchmark();
  } finally {
    await mongoose.disconnect();
  }
  process.exit(0);
};

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((err) => {
    console.error("Benchmark failed:", err);
    process.exit(1);
  });
}
