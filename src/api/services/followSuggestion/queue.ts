import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import FollowSuggestion from "../../models/followSuggestion.model.ts";
import { computeSuggestionsForUser } from "../followSuggestion.ts";
import { FOLLOW_SUGGESTION_CONFIG } from "./config.ts";

const connection = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null,
});

export const followSuggestionQueue = new Queue("follow-suggestion", { connection });

const workers: Worker[] = [];

export type FollowSuggestionJobData = { userIds: string[] };

export type ProcessBatchJobDeps = {
  compute?: (userId: string) => ReturnType<typeof computeSuggestionsForUser>;
};

export const processBatchJob = async (
  data: FollowSuggestionJobData,
  deps: ProcessBatchJobDeps = {},
): Promise<void> => {
  const compute = deps.compute ?? computeSuggestionsForUser;
  for (const userId of data.userIds) {
    const candidates = await compute(userId);
    await FollowSuggestion.findOneAndUpdate(
      { userId },
      { $set: { candidates, computedAt: new Date() } },
      { upsert: true },
    );
  }
};

export const enqueueOnDemandSuggestion = async (userId: string): Promise<void> => {
  if (!FOLLOW_SUGGESTION_CONFIG.enabled) return;
  try {
    await followSuggestionQueue.add(
      "on-demand-user",
      { userIds: [userId] },
      {
        jobId: `on-demand:${userId}`,
        priority: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  } catch (err) {
    console.error("[follow-suggestion-queue] enqueueOnDemandSuggestion failed:", err);
  }
};

export const registerFollowSuggestionWorker = (conn: Redis): Worker => {
  const worker = new Worker(
    "follow-suggestion",
    async (job) => processBatchJob(job.data),
    { connection: conn, concurrency: FOLLOW_SUGGESTION_CONFIG.workerConcurrency },
  );
  workers.push(worker);
  return worker;
};

export const initFollowSuggestionWorker = (): void => {
  registerFollowSuggestionWorker(connection);
};

export const closeFollowSuggestionQueue = async (): Promise<void> => {
  await Promise.all(workers.splice(0).map((w) => w.close()));
  await followSuggestionQueue.close();
  await connection.quit();
};
