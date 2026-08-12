const num = (
  raw: string | undefined,
  def: number,
  key: string,
  mustBePositive = false,
): number => {
  if (raw === undefined || raw === "") return def;
  const v = Number(raw);
  if (!Number.isFinite(v) || (mustBePositive && v <= 0)) {
    console.warn(
      `[feed-config] ${key}="${raw}" không parse được, dùng default ${def}`,
    );
    return def;
  }
  return v;
};

const int = (raw: string | undefined, def: number, key: string): number =>
  Math.trunc(num(raw, def, key, true));

export const ratio = (
  raw: string | undefined,
  def: number,
  key: string,
): number => {
  if (raw === undefined || raw === "") return def;
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    console.warn(
      `[feed-config] ${key}="${raw}" không parse được, dùng default ${def}`,
    );
    return def;
  }
  if (v < 0) {
    console.warn(
      `[feed-config] ${key}="${raw}" âm — không hợp lệ, dùng default ${def}`,
    );
    return def;
  }
  if (v > 1) {
    console.warn(`[feed-config] ${key}="${raw}" > 1, clamp về 1`);
    return 1;
  }
  return v;
};

export const FEED_CONFIG = Object.freeze({
  alpha: num(process.env.FEED_ALPHA, 1, "FEED_ALPHA"),
  beta: num(process.env.FEED_BETA, 1, "FEED_BETA"),
  halfLifeHours: num(
    process.env.FEED_HALF_LIFE_HOURS,
    6,
    "FEED_HALF_LIFE_HOURS",
    true,
  ),
  celebrityThreshold: int(
    process.env.FEED_CELEBRITY_FOLLOWER_THRESHOLD,
    50000,
    "FEED_CELEBRITY_FOLLOWER_THRESHOLD",
  ),
  zsetMaxSize: int(process.env.FEED_ZSET_MAX_SIZE, 500, "FEED_ZSET_MAX_SIZE"),
  candidatePool: int(
    process.env.FEED_CANDIDATE_POOL,
    300,
    "FEED_CANDIDATE_POOL",
  ),
  scoreBucketSeconds: int(
    process.env.FEED_SCORE_BUCKET_SECONDS,
    60,
    "FEED_SCORE_BUCKET_SECONDS",
  ),
  fanoutEnabled: process.env.FEED_FANOUT_ENABLED !== "false",
  socketEnabled: process.env.FEED_SOCKET_ENABLED === "true",
  activeWindowDays: 7,
  discoveryEnabled: process.env.FEED_DISCOVERY_ENABLED !== "false",
  discoveryRatio: ratio(
    process.env.FEED_DISCOVERY_RATIO,
    0.15,
    "FEED_DISCOVERY_RATIO",
  ),
  discoveryMaxSkip: int(
    process.env.FEED_DISCOVERY_MAX_SKIP,
    1000,
    "FEED_DISCOVERY_MAX_SKIP",
  ),
  fanoutMode: process.env.FEED_FANOUT_MODE === "direct" ? "direct" : "queue",
  fanoutQueueConcurrency: int(
    process.env.FEED_FANOUT_QUEUE_CONCURRENCY,
    20,
    "FEED_FANOUT_QUEUE_CONCURRENCY",
  ),
  fanoutBatchConcurrency: int(
    process.env.FEED_FANOUT_BATCH_CONCURRENCY,
    100,
    "FEED_FANOUT_BATCH_CONCURRENCY",
  ),
  fanoutBatchRateLimitMax: int(
    process.env.FEED_FANOUT_BATCH_RATE_LIMIT_MAX,
    100,
    "FEED_FANOUT_BATCH_RATE_LIMIT_MAX",
  ),
  fanoutBatchRateLimitDurationMs: int(
    process.env.FEED_FANOUT_BATCH_RATE_LIMIT_DURATION_MS,
    1000,
    "FEED_FANOUT_BATCH_RATE_LIMIT_DURATION_MS",
  ),
});

console.log("[feed-config]", FEED_CONFIG);
