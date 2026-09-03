import dotenv from "dotenv";
import mongoose, { type Types } from "mongoose";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import User from "../models/user.model.ts";
import {
  processBatchJob,
  type ProcessBatchJobDeps,
} from "../services/followSuggestion/queue.ts";
import { FOLLOW_SUGGESTION_CONFIG } from "../services/followSuggestion/config.ts";
import { LOCK_KEY } from "../services/followSuggestion/cron.ts";
import initRedis, { getRedisInstance } from "../../dbs/redis.ts";

dotenv.config();

const PROGRESS_COLLECTION = "backfillProgress";
const SCRIPT_NAME = "follow-suggestions";
const DEFAULT_CONCURRENCY = 5;

const readLastProcessedId = async (): Promise<Types.ObjectId | null> => {
  const doc = await mongoose.connection.db
    .collection(PROGRESS_COLLECTION)
    .findOne({ scriptName: SCRIPT_NAME });
  return (doc?.lastProcessedId as Types.ObjectId | undefined) ?? null;
};

const saveLastProcessedId = async (lastProcessedId: Types.ObjectId): Promise<void> => {
  await mongoose.connection.db.collection(PROGRESS_COLLECTION).updateOne(
    { scriptName: SCRIPT_NAME },
    { $set: { lastProcessedId, updatedAt: new Date() } },
    { upsert: true },
  );
};

export type BackfillOptions = {
  concurrency: number;
  resume: boolean;
  shouldStop?: () => boolean;
};

export type BackfillDeps = Pick<ProcessBatchJobDeps, "compute">;

export type BackfillResult = { processedCount: number };

export const runBackfill = async (
  options: BackfillOptions,
  deps: BackfillDeps = {},
): Promise<BackfillResult> => {
  const { concurrency, resume, shouldStop } = options;
  let cursor = resume ? await readLastProcessedId() : null;
  let processedCount = 0;

  while (!(shouldStop?.() ?? false)) {
    const filter = cursor ? { _id: { $gt: cursor } } : {};
    const page: { _id: Types.ObjectId }[] = await User.find(filter, { _id: 1 })
      .sort({ _id: 1 })
      .limit(concurrency)
      .lean();
    if (page.length === 0) break;

    await Promise.all(page.map((u) => processBatchJob({ userIds: [String(u._id)] }, deps)));

    cursor = page[page.length - 1]._id;
    processedCount += page.length;
    await saveLastProcessedId(cursor);
    console.log(
      `[backfill-follow-suggestions] processed ${processedCount} users so far (cursor=${cursor})`,
    );
  }

  return { processedCount };
};

type LockHandle = { extend: () => Promise<void>; release: () => Promise<void> };

const acquireLock = async (): Promise<LockHandle | null> => {
  const redis = getRedisInstance();
  if (!redis) throw new Error("Redis instance not found");
  const token = randomUUID();
  const ok = await redis.set(LOCK_KEY, token, "EX", FOLLOW_SUGGESTION_CONFIG.lockTtlSeconds, "NX");
  if (ok !== "OK") return null;
  return {
    extend: async () => {
      const current = await redis.get(LOCK_KEY);
      if (current === token) await redis.expire(LOCK_KEY, FOLLOW_SUGGESTION_CONFIG.lockTtlSeconds);
    },
    release: async () => {
      const current = await redis.get(LOCK_KEY);
      if (current === token) await redis.del(LOCK_KEY);
    },
  };
};

const parseArgs = (argv: string[]): { concurrency: number; resume: boolean } => {
  let concurrency = DEFAULT_CONCURRENCY;
  let resume = false;
  for (const arg of argv) {
    if (arg === "--resume") {
      resume = true;
    } else if (arg.startsWith("--concurrency=")) {
      const value = Number(arg.slice("--concurrency=".length));
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`--concurrency phải là số nguyên >= 1, nhận: "${arg}"`);
      }
      concurrency = value;
    }
  }
  return { concurrency, resume };
};

const main = async () => {
  const { concurrency, resume } = parseArgs(process.argv.slice(2));
  console.log(
    `[backfill-follow-suggestions] start (concurrency=${concurrency}, resume=${resume})`,
  );

  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017");
  initRedis();
  await new Promise<void>((resolve, reject) => {
    const r = getRedisInstance()!;
    if (r.status === "ready") return resolve();
    r.once("ready", () => resolve());
    r.once("error", reject);
  });

  const lock = await acquireLock();
  if (!lock) {
    console.error(
      `[backfill-follow-suggestions] không lấy được lock "${LOCK_KEY}" (cron task 012 hoặc 1 lần ` +
        "chạy backfill khác đang giữ) — bỏ qua lần chạy này, thử lại sau.",
    );
    await mongoose.disconnect();
    await getRedisInstance()?.quit();
    process.exit(1);
  }

  const heartbeat = setInterval(
    () => void lock.extend(),
    Math.floor((FOLLOW_SUGGESTION_CONFIG.lockTtlSeconds * 1000) / 2),
  );
  heartbeat.unref();

  let stopRequested = false;
  const requestStop = (signal: string) => {
    console.log(
      `[backfill-follow-suggestions] nhận ${signal} — dừng sau khi trang hiện tại xong (tiến độ ` +
        "đã lưu, chạy lại với --resume để tiếp tục).",
    );
    stopRequested = true;
  };
  process.on("SIGINT", () => requestStop("SIGINT"));
  process.on("SIGTERM", () => requestStop("SIGTERM"));

  try {
    const { processedCount } = await runBackfill({
      concurrency,
      resume,
      shouldStop: () => stopRequested,
    });
    console.log(
      `[backfill-follow-suggestions] hoàn tất: ${processedCount} user đã xử lý trong lần chạy này.`,
    );
  } finally {
    clearInterval(heartbeat);
    await lock.release();
    await mongoose.disconnect();
    await getRedisInstance()?.quit();
  }
  process.exit(stopRequested ? 130 : 0);
};

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((err) => {
    console.error("[backfill-follow-suggestions] failed:", err);
    process.exit(1);
  });
}
