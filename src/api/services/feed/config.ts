const num = (
  raw: string | undefined,
  def: number,
  key: string,
  mustBePositive = false
): number => {
  if (raw === undefined || raw === "") return def;
  const v = Number(raw);
  if (!Number.isFinite(v) || (mustBePositive && v <= 0)) {
    console.warn(`[feed-config] ${key}="${raw}" không parse được, dùng default ${def}`);
    return def;
  }
  return v;
};

const int = (raw: string | undefined, def: number, key: string): number =>
  Math.trunc(num(raw, def, key, true));

export const FEED_CONFIG = Object.freeze({
  alpha: num(process.env.FEED_ALPHA, 1, "FEED_ALPHA"),
  beta: num(process.env.FEED_BETA, 1, "FEED_BETA"),
  halfLifeHours: num(
    process.env.FEED_HALF_LIFE_HOURS,
    6,
    "FEED_HALF_LIFE_HOURS",
    true
  ),
  celebrityThreshold: int(
    process.env.FEED_CELEBRITY_FOLLOWER_THRESHOLD,
    50000,
    "FEED_CELEBRITY_FOLLOWER_THRESHOLD"
  ),
  zsetMaxSize: int(process.env.FEED_ZSET_MAX_SIZE, 500, "FEED_ZSET_MAX_SIZE"),
  candidatePool: int(
    process.env.FEED_CANDIDATE_POOL,
    300,
    "FEED_CANDIDATE_POOL"
  ),
  scoreBucketSeconds: int(
    process.env.FEED_SCORE_BUCKET_SECONDS,
    60,
    "FEED_SCORE_BUCKET_SECONDS"
  ),
  fanoutEnabled: process.env.FEED_FANOUT_ENABLED !== "false",
  socketEnabled: process.env.FEED_SOCKET_ENABLED === "true",
  activeWindowDays: 7,
});

console.log("[feed-config]", FEED_CONFIG);
