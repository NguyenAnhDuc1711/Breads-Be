// Benchmark thủ công cho FR-4/NFR-1/SC-5 (epic rate-limit-algorithms, task 011) — đo (a) latency
// p50/p95/p99 của limiter in-memory hiện tại (baseline) vs limiter Redis-backed đang chạy shadow
// mode (task 003), và delta giữa 2 bên (SC-5 chốt trên số này: p95 thêm ≤ 20ms); (b) tỷ lệ
// lỗi/timeout Redis quan sát được trong cùng lần chạy (FR-4(b)).
//
// KHÁC quy ước benchmark k6 hiện có trong `test/` (`*-stress.js`, cần server thật + docker): AD-5/
// plan-review Lake Score 0E đã loại k6 cho benchmark này — `authTierLimiter` chỉ `max=5/60s`, quy
// mô quá nhỏ để dựng hạ tầng nhiều VU/network thật (NFR-3: không thêm hạ tầng). Đây là 1 script
// Node đơn thuần, gọi thẳng 2 `Store` (không qua HTTP/Express) để đo đúng chi phí round-trip của
// mỗi store, không lẫn overhead của layer HTTP.
//
// Phương pháp (apples-to-apples — đọc kỹ trước khi diễn giải số liệu):
//   - Baseline "in-memory": `MemoryStore` của chính `express-rate-limit` (cùng class mà
//     `createRateLimiter()` dùng khi KHÔNG truyền `store` — xem rateLimiter.ts) — gọi thẳng
//     `.increment(key)`, KHÔNG qua Express/HTTP.
//   - "Redis-backed": `authRedisStore` (rateLimitRedisStore.ts, export mà `authTierLimiter` dùng ở
//     shadow mode) — cũng gọi thẳng `.increment(key)`, cùng cách đo, cùng N mẫu.
//   - Mỗi mẫu dùng 1 key riêng biệt (không tái sử dụng) — mô phỏng nhiều client khác nhau (nhiều
//     IP), tránh nhánh "blocked" của Lua script (AD-4) làm lệch chi phí round-trip đang muốn đo
//     (khác câu hỏi "limiter có chặn đúng không" — đã có test riêng ở task 010).
//   - Latency đo bằng `performance.now()` quanh đúng lệnh `.increment()`, giống hệt cách
//     `observeAuthTierShadow()` trong rateLimiter.ts đo `latencyMs` — số liệu ở đây tương đương số
//     sẽ thấy trong log production thật.
//
// Cold-start artifact (đã biết trước, xem handoff task 001/002 + skillbook SKL-005): lệnh Redis
// ĐẦU TIÊN sau khi tạo connection riêng (`.duplicate()`, lazy, `enableOfflineQueue:false`) luôn lỗi
// vì socket còn ở trạng thái "connecting". Script này chạy 1 lệnh warm-up TRƯỚC vòng đo, loại nó
// khỏi mọi percentile/tỷ lệ lỗi steady-state, và báo cáo riêng — KHÔNG để nó làm lệch số liệu.
//
// Provenance (đọc trước khi dùng số liệu này để chốt NFR-1/SC-5 — task 020): đây là số đo LOCAL,
// 1 lần chạy, Redis + Node trên CÙNG máy (127.0.0.1, không qua mạng thật), chạy dồn dập (không trải
// theo thời gian) — KHÔNG phải số đo trên staging/production traffic thật. Tỷ lệ lỗi 0% ở đây chỉ
// có nghĩa "ổn định trong 1 lần chạy ngắn trên máy dev", KHÔNG chứng minh Redis production sẽ không
// bao giờ lỗi/timeout.
//
// Chạy thủ công (đã verify cả 2 cách chạy được — dùng `node` thẳng, không cần tsx vì Node 22 tự
// strip type annotation của các file .ts import vào đây):
//   docker compose up -d redis   # hoặc xác nhận Redis đã chạy ở 127.0.0.1:6379
//   node test/rate-limit-auth-benchmark.js
// KHÔNG chạy qua "npm test" — không khớp glob test runner trong package.json, đây là công cụ đo
// thủ công, không phải test pass/fail.

import initRedis, { getRedisInstance } from "../src/dbs/redis.ts";
import { authRedisStore } from "../src/api/middlewares/rateLimitRedisStore.ts";
import logger from "../src/core/logger.ts";
import { MemoryStore } from "express-rate-limit";

const SAMPLE_SIZE = 500; // cùng cỡ mẫu cho cả 2 bên — nằm trong khoảng 500-1000 mà 011.md đề xuất
const AUTH_TIER_WINDOW_MS = 60_000; // khớp AUTH_TIER_WINDOW_MS thật trong rateLimiter.ts

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

/* --------------------------------------------------------- baseline: in-memory MemoryStore */

const benchmarkInMemory = async (n) => {
  // Cùng class mà `createRateLimiter()` dùng mặc định khi không truyền `store` (xem rateLimiter.ts)
  // — `init()` phải gọi tay 1 lần vì bình thường `rateLimit()` middleware tự gọi lúc khởi tạo route.
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

/* ---------------------------------------------------- Redis-backed: authRedisStore (shadow) */

const benchmarkRedis = async (n) => {
  // Warm-up: hấp thụ lỗi cold-start đã biết trước (xem comment đầu file), KHÔNG tính vào steady-state.
  const warmupKey = "bench-warmup";
  const warmupStart = performance.now();
  let warmupErrored = false;
  const restoreWarnLogger = interceptFailOpenLogs(() => {
    warmupErrored = true;
  });
  await authRedisStore.increment(warmupKey);
  restoreWarnLogger();
  const warmupLatencyMs = performance.now() - warmupStart;

  // Cho event loop 1 khoảng nghỉ thật (macrotask) để connection riêng (`.duplicate()`, task 002)
  // hoàn tất TCP handshake — nếu gọi steady-state ngay sau warm-up trong cùng loạt microtask,
  // TCP connect (I/O thật, cần vòng lặp sự kiện tiến, không chỉ await liên tiếp) chưa kịp xong và
  // MỌI mẫu sẽ lỗi giống warm-up, không riêng gì mẫu đầu — verify thực tế lúc viết script này.
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

  // Dọn key đã tạo — không để sót key rác trên Redis (yêu cầu: script phải deterministic/sạch sau
  // khi chạy). `resetKey` gọi `DEL` trực tiếp qua `authRedisStore` (rateLimitRedisStore.ts).
  await Promise.all([warmupKey, ...keys].map((k) => authRedisStore.resetKey(k).catch(() => {})));

  return { samples, warmupLatencyMs, warmupErrored, steadyStateErrors };
};

// `authRedisStore` (task 002) fail-open NUỐT mọi lỗi Redis — không throw ra ngoài — nên cách duy
// nhất để đếm "tỷ lệ lỗi/timeout Redis quan sát được" (FR-4(b)) là đếm đúng 2 log line mà
// `withFailOpen` phát ra (xem rateLimitRedisStore.ts): `logger.warn` (1 lỗi đơn lẻ, chưa đủ
// debounce) hoặc `logger.error` (≥2 lỗi liên tiếp, coi là down) — cả 2 đều = 1 lần gọi
// `.increment()` bị lỗi/timeout thật. Monkey-patch tạm thời quanh ĐÚNG 1 lệnh gọi, restore ngay sau
// — không đổi hành vi log của phần còn lại chương trình, không làm nhiễu output bảng kết quả.
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

/* --------------------------------------------------------------------------------- main */

(async () => {
  initRedis();
  // Chờ connection Redis CHUNG (base client, dùng bởi phần còn lại app.ts) sẵn sàng trước khi tạo
  // connection riêng (`.duplicate()`, lazy trong rateLimitRedisStore.ts) — cùng lý do warm-up ở trên.
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
  // Connection riêng (`.duplicate()` trong rateLimitRedisStore.ts) không có handle export ra ngoài
  // để tự đóng — process.exit() là cách duy nhất đảm bảo script không treo (verify thực tế: không
  // có exit này, process không bao giờ tự thoát vì socket riêng đó vẫn mở).
  process.exit(sc5Pass ? 0 : 1);
})();
