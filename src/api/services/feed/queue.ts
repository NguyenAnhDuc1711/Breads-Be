import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { FEED_CONFIG } from "./config.ts";
import { processBatchJob, processDispatchJob } from "./fanout.ts";

const connection = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null,
});

export const dispatchQueue = new Queue("feed-fanout", { connection });
export const batchQueue = new Queue("feed-fanout-batch", { connection });

const workers: Worker[] = [];

export const registerDispatchWorker = (io: any, conn: Redis): Worker => {
  const worker = new Worker(
    "feed-fanout",
    async (job) => processDispatchJob(job.data, io),
    { connection: conn, concurrency: FEED_CONFIG.fanoutQueueConcurrency },
  );
  workers.push(worker);
  return worker;
};

export const registerBatchWorker = (conn: Redis): Worker => {
  const worker = new Worker(
    "feed-fanout-batch",
    async (job) => processBatchJob(job.data),
    {
      connection: conn,
      concurrency: FEED_CONFIG.fanoutBatchConcurrency,
      limiter: {
        max: FEED_CONFIG.fanoutBatchRateLimitMax,
        duration: FEED_CONFIG.fanoutBatchRateLimitDurationMs,
      },
    },
  );
  workers.push(worker);
  return worker;
};

export const initFanoutWorkers = (io: any): void => {
  registerDispatchWorker(io, connection);
  registerBatchWorker(connection);
};

export const closeFanoutQueues = async (): Promise<void> => {
  await Promise.all(workers.splice(0).map((w) => w.close()));
  await Promise.all([dispatchQueue.close(), batchQueue.close()]);
  await connection.quit();
};
