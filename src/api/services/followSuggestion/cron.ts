import cron from "node-cron";
import mongoose from "mongoose";
import { getRedisInstance } from "../../../dbs/redis.ts";
import User from "../../models/user.model.ts";
import { followSuggestionQueue, type FollowSuggestionJobData } from "./queue.ts";
import { FOLLOW_SUGGESTION_CONFIG } from "./config.ts";

export const LOCK_KEY = "follow-suggestion:refresh-lock";

export const ENQUEUE_BATCH_SIZE = 300;

export const acquireLock = async (
  lockValue: string,
  ttlSeconds: number,
): Promise<boolean> => {
  const redis = getRedisInstance();
  if (!redis) {
    console.warn(
      "[follow-suggestion-cron] Redis chưa init (getRedisInstance() = null) — coi như acquire " +
        "lock thất bại, bỏ qua lần chạy này (fail-safe: không enqueue khi không chắc chắn không " +
        "có process khác đang chạy).",
    );
    return false;
  }
  const result = await redis.set(LOCK_KEY, lockValue, "EX", ttlSeconds, "NX");
  return result === "OK";
};

export type RunFollowSuggestionRefreshDeps = {
  enqueue?: (data: FollowSuggestionJobData) => Promise<unknown>;
  batchSize?: number;
};

export type RunFollowSuggestionRefreshResult = {
  acquired: boolean;
  jobCount: number;
};

const DAY_MS = 86400_000;
const activeCutoff = (): Date =>
  new Date(Date.now() - FOLLOW_SUGGESTION_CONFIG.activeWindowDays * DAY_MS);

export const runFollowSuggestionRefresh = async (
  deps: RunFollowSuggestionRefreshDeps = {},
): Promise<RunFollowSuggestionRefreshResult> => {
  const enqueue =
    deps.enqueue ??
    ((data: FollowSuggestionJobData) => followSuggestionQueue.add("refresh-batch", data));
  const batchSize = deps.batchSize ?? ENQUEUE_BATCH_SIZE;
  const lockValue = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

  const acquired = await acquireLock(lockValue, FOLLOW_SUGGESTION_CONFIG.lockTtlSeconds);
  if (!acquired) {
    console.warn(
      `[follow-suggestion-cron] lock "${LOCK_KEY}" đang bị giữ (backfill task 020 hoặc lần chạy ` +
        `trước chưa hết TTL) — bỏ qua lần chạy này, KHÔNG enqueue.`,
    );
    return { acquired: false, jobCount: 0 };
  }

  let jobCount = 0;
  const cutoff = activeCutoff();
  let cursor: { lastActiveAt: Date; _id: mongoose.Types.ObjectId } | undefined;
  for (;;) {
    const query: Record<string, unknown> = { lastActiveAt: { $gte: cutoff } };
    if (cursor) {
      query.$or = [
        { lastActiveAt: { $lt: cursor.lastActiveAt } },
        { lastActiveAt: cursor.lastActiveAt, _id: { $lt: cursor._id } },
      ];
    }
    const users = await User.find(query)
      .sort({ lastActiveAt: -1, _id: -1 })
      .limit(batchSize)
      .select("_id lastActiveAt")
      .lean();
    if (users.length === 0) break;

    const userIds = users.map((u: any) => String(u._id));
    await enqueue({ userIds });
    jobCount += 1;
    const last = users[users.length - 1];
    cursor = { lastActiveAt: last.lastActiveAt, _id: last._id };

    if (users.length < batchSize) break;
  }

  console.log(
    `[follow-suggestion-cron] enqueued ${jobCount} batch job(s); lock "${LOCK_KEY}" sẽ tự hết ` +
      `hạn sau ${FOLLOW_SUGGESTION_CONFIG.lockTtlSeconds}s (không release tường minh, xem AD-7).`,
  );
  return { acquired: true, jobCount };
};

export const initFollowSuggestionCron = () =>
  cron.schedule(FOLLOW_SUGGESTION_CONFIG.refreshCronSchedule, () => {
    runFollowSuggestionRefresh().catch((err) => {
      console.error("[follow-suggestion-cron] runFollowSuggestionRefresh failed:", err);
    });
  });
