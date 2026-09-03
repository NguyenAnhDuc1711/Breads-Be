
import initRedis, { getRedisInstance } from "../src/dbs/redis.ts";
import { authRedisStore } from "../src/api/middlewares/rateLimitRedisStore.ts";
import logger from "../src/core/logger.ts";
import { MemoryStore } from "express-rate-limit";

const SAMPLE_SIZE = 500;
const AUTH_TIER_WINDOW_MS = 60_000;

const percentile = (sortedAsc, p) => {
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
};

const summarize = (samplesMs) => {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
};

const round2 = (n) => Math.round(n * 100) / 100;

const benchmarkInMemory = async (n) => {
  const store = new MemoryStore();
  store.init({ windowMs: AUTH_TIER_WINDOW_MS });

  const samples = [];
  for (let i = 0; i < n; i++) {
    const key = `bench-mem-${i}`;
    const start = performance.now();
    await store.increment(key);
    samples.push(performance.now() - start);
  }
  return samples;
};

const benchmarkRedis = async (n) => {
  const warmupKey = "bench-warmup";
  const warmupStart = performance.now();
  let warmupErrored = false;
  const restoreWarnLogger = interceptFailOpenLogs(() => {
    warmupErrored = true;
  });
  await authRedisStore.increment(warmupKey);
  restoreWarnLogger();
  const warmupLatencyMs = performance.now() - warmupStart;

  await new Promise((r) => setTimeout(r, 200));

  const samples = [];
  let steadyStateErrors = 0;
  const keys = [];
  for (let i = 0; i < n; i++) {
    const key = `bench-redis-${i}`;
    keys.push(key);
    let erroredThisCall = false;
    const restore = interceptFailOpenLogs(() => {
      erroredThisCall = true;
    });
    const start = performance.now();
    await authRedisStore.increment(key);
    restore();
    samples.push(performance.now() - start);
    if (erroredThisCall) steadyStateErrors++;
  }

  await Promise.all([warmupKey, ...keys].map((k) => authRedisStore.resetKey(k).catch(() => {})));

  return { samples, warmupLatencyMs, warmupErrored, steadyStateErrors };
};

const interceptFailOpenLogs = (onFailOpen) => {
  const originalWarn = logger.warn.bind(logger);
  const originalError = logger.error.bind(logger);
  logger.warn = (...args) => {
    onFailOpen();
    return originalWarn(...args);
  };
  logger.error = (...args) => {
    onFailOpen();
    return originalError(...args);
  };
  return () => {
    logger.warn = originalWarn;
    logger.error = originalError;
  };
};

(async () => {
  initRedis();
  await new Promise((r) => setTimeout(r, 300));

  console.log(`Đang chạy benchmark (N=${SAMPLE_SIZE} mỗi bên)...`);

  const inMemorySamples = await benchmarkInMemory(SAMPLE_SIZE);
  const { samples: redisSamples, warmupLatencyMs, warmupErrored, steadyStateErrors } =
    await benchmarkRedis(SAMPLE_SIZE);

  const inMemoryStats = summarize(inMemorySamples);
  const redisStats = summarize(redisSamples);
  const deltaP95 = redisStats.p95 - inMemoryStats.p95;
  const errorRatePct = (steadyStateErrors / SAMPLE_SIZE) * 100;
  const sc5Pass = deltaP95 <= 20;

  const result = {
    task: "011",
    epic: "rate-limit-algorithms",
    provenance: "LOCAL, 1 lần chạy, Redis+Node cùng máy (127.0.0.1), chạy dồn dập — KHÔNG phải staging/production traffic thật",
    sampleSize: SAMPLE_SIZE,
    coldStartArtifact: {
      note: "Lệnh Redis đầu tiên sau khi tạo connection riêng — loại khỏi mọi số liệu bên dưới, báo riêng",
      latencyMs: round2(warmupLatencyMs),
      errored: warmupErrored,
    },
    latencyMs: {
      inMemoryBaseline: {
        p50: round2(inMemoryStats.p50),
        p95: round2(inMemoryStats.p95),
        p99: round2(inMemoryStats.p99),
      },
      redisBackedShadow: {
        p50: round2(redisStats.p50),
        p95: round2(redisStats.p95),
        p99: round2(redisStats.p99),
      },
      deltaP95: round2(deltaP95),
    },
    redisErrorTimeoutRate: {
      steadyStateCalls: SAMPLE_SIZE,
      erroredCalls: steadyStateErrors,
      ratePct: round2(errorRatePct),
    },
    nfr1Budget: { commandTimeoutMs: 100, debounceConsecutiveFailures: 2 },
    sc5: {
      thresholdMs: 20,
      deltaP95Ms: round2(deltaP95),
      pass: sc5Pass,
    },
  };

  console.log("\n=== Bảng kết quả (ms, trừ tỷ lệ lỗi) ===");
  console.table({
    "in-memory (baseline)": inMemoryStats,
    "Redis-backed (shadow)": redisStats,
  });
  console.log(`Delta p95 (Redis - in-memory): ${round2(deltaP95)} ms  (ngân sách SC-5: ≤ 20ms)`);
  console.log(
    `Tỷ lệ lỗi/timeout Redis (steady-state, N=${SAMPLE_SIZE}): ${round2(errorRatePct)}% (${steadyStateErrors}/${SAMPLE_SIZE})`
  );
  console.log(
    `Cold-start (mẫu đầu tiên, loại khỏi số liệu trên): ${round2(warmupLatencyMs)}ms, errored=${warmupErrored}`
  );
  console.log(`SC-5 (p95 thêm ≤ 20ms): ${sc5Pass ? "PASS" : "FAIL"}`);

  console.log("\n=== RESULTS_JSON_START ===");
  console.log(JSON.stringify(result, null, 2));
  console.log("=== RESULTS_JSON_END ===");

  await getRedisInstance()?.quit().catch(() => {});
  process.exit(sc5Pass ? 0 : 1);
})();
