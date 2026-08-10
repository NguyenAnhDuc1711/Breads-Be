import { NextFunction, Request, Response } from "express";
import client from "prom-client";
import { batchQueue, dispatchQueue } from "../services/feed/queue.ts";
import logger from "../../core/logger.ts";

export const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
  registers: [register],
});

// FR-9: queue depth cho 2 queue fan-out (thay thế nhu cầu dựng Bull Board — xem 013.md).
const feedFanoutQueueWaiting = new client.Gauge({
  name: "feed_fanout_queue_waiting",
  help: "Số job đang waiting trong queue fan-out",
  labelNames: ["queue"],
  registers: [register],
});
const feedFanoutQueueFailed = new client.Gauge({
  name: "feed_fanout_queue_failed",
  help: "Số job failed trong queue fan-out",
  labelNames: ["queue"],
  registers: [register],
});

export const metricsMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const endTimer = httpRequestDuration.startTimer();
  res.on("finish", () => {
    endTimer({
      method: req.method,
      route: req.route?.path || req.path,
      status_code: res.statusCode,
    });
  });
  next();
};

export const metricsHandler = async (_req: Request, res: Response) => {
  try {
    const [dispatchCounts, batchCounts] = await Promise.all([
      dispatchQueue.getJobCounts("waiting", "failed"),
      batchQueue.getJobCounts("waiting", "failed"),
    ]);
    feedFanoutQueueWaiting.set({ queue: "dispatch" }, dispatchCounts.waiting ?? 0);
    feedFanoutQueueWaiting.set({ queue: "batch" }, batchCounts.waiting ?? 0);
    feedFanoutQueueFailed.set({ queue: "dispatch" }, dispatchCounts.failed ?? 0);
    feedFanoutQueueFailed.set({ queue: "batch" }, batchCounts.failed ?? 0);
  } catch (err) {
    // Redis down lúc scrape — không để lỗi getJobCounts() làm hỏng phần response /metrics còn lại
    // (HTTP metrics vẫn phải trả được, NFR-3-style fail-safe).
    logger.error({ err }, "[metrics] getJobCounts thất bại, bỏ qua gauge queue");
  }
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
};
