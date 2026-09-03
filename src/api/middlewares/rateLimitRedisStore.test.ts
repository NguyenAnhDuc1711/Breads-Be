import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import express from "express";
import { ipKeyGenerator } from "express-rate-limit";
import type { ClientRateLimitInfo, Store } from "express-rate-limit";
import Redis from "ioredis";
import type { Redis as RedisType } from "ioredis";
import logger from "../../core/logger.ts";
import initRedis, { getRedisInstance } from "../../dbs/redis.ts";
import { authTierLimiter, createRateLimiter } from "./rateLimiter.ts";
import {
  authRedisStore,
  createRedisSlidingWindowStore,
  withFailOpen,
} from "./rateLimitRedisStore.ts";

const KEY_PREFIX = "rl:sw:";
const WINDOW_MS = 60_000;
const MAX = 5;

const RUN_ID = `t010-${process.pid}-${Date.now()}`;
const testKey = (name: string) => `${RUN_ID}:${name}`;

const probeRedis = async (): Promise<string | false> => {
  const probe = new Redis({
    host: process.env.REDIS_HOST || "localhost",
    port: Number(process.env.REDIS_PORT || 6379),
    lazyConnect: true,
    connectTimeout: 1000,
    retryStrategy: () => null,
    maxRetriesPerRequest: 1,
  });
  probe.on("error", () => {});
  try {
    await probe.connect();
    await probe.ping();
    return false;
  } catch {
    return "Redis không khả dụng (REDIS_HOST/REDIS_PORT, mặc định localhost:6379) — bỏ qua test cần Redis thật";
  } finally {
    probe.disconnect();
  }
};

const skipNoRedis = await probeRedis();
const needsRedis = { skip: skipNoRedis };

let base: RedisType;
let dedicated: RedisType | null = null;
let store: Store;

before(async () => {
  if (skipNoRedis) return;
  initRedis();
  base = getRedisInstance() as RedisType;

  const originalDuplicate = base.duplicate.bind(base);
  (base as unknown as { duplicate: unknown }).duplicate = (opts: unknown) => {
    dedicated = originalDuplicate(opts as never);
    return dedicated;
  };

  if (base.status !== "ready") await once(base, "ready");

  store = createRedisSlidingWindowStore({ windowMs: WINDOW_MS, max: MAX });

  await store.increment(testKey("warmup")).catch(() => {});
  if (dedicated && (dedicated as RedisType).status !== "ready") {
    await once(dedicated as RedisType, "ready");
  }
});

after(async () => {
  if (skipNoRedis) return;
  await base.del(`${KEY_PREFIX}${testKey("warmup")}`).catch(() => {});
  base.removeAllListeners("end");
  base.disconnect();
  dedicated?.disconnect();
});

const zcard = (key: string) => base.zcard(`${KEY_PREFIX}${key}`);
const pttl = (key: string) => base.pttl(`${KEY_PREFIX}${key}`);

const realDateNow = Date.now;
const atTime = async <T>(ms: number, fn: () => Promise<T>): Promise<T> => {
  Date.now = () => ms;
  try {
    return await fn();
  } finally {
    Date.now = realDateNow;
  }
};

test("US-1: 5 lần increment đầu trong 1 cửa sổ 60s đều ≤ max, lần thứ 6 vượt ngưỡng", needsRedis, async () => {
  const key = testKey("us1");
  const hits: number[] = [];
  for (let i = 0; i < 6; i++) hits.push((await store.increment(key)).totalHits);

  assert.deepEqual(hits, [1, 2, 3, 4, 5, 6], "phải đếm tăng dần 1..5 rồi trả 6 ở lần thứ 6");
  assert.ok(
    hits.slice(0, 5).every((h) => h <= MAX),
    "5 lần đầu không được vượt ngưỡng"
  );
  assert.ok(hits[5] > MAX, "lần thứ 6 phải > max để middleware trả 429");
  await store.resetKey?.(key);
});

test("SC-1 / US-2 (boundary-burst): 5 request cuối cửa sổ N + 5 đầu cửa sổ N+1 -> chỉ 5 lọt qua", needsRedis, async () => {
  const key = testKey("us2-burst");
  const allowed: number[] = [];
  const blocked: number[] = [];
  const record = (totalHits: number) =>
    (totalHits <= MAX ? allowed : blocked).push(totalHits);

  await atTime(59_900, async () => {
    for (let i = 0; i < 5; i++) record((await store.increment(key)).totalHits);
  });
  await atTime(60_100, async () => {
    for (let i = 0; i < 5; i++) record((await store.increment(key)).totalHits);
  });

  assert.equal(allowed.length, MAX, `chỉ được phép đúng ${MAX} request lọt qua, thực tế ${allowed.length}`);
  assert.equal(blocked.length, 5, "cả 5 request của nhóm thứ 2 phải bị chặn");
  assert.ok(
    blocked.every((h) => h > MAX),
    "mọi request bị chặn phải trả totalHits > max"
  );
  assert.equal(await zcard(key), MAX, "ZSET chỉ chứa đúng 5 entry được chấp nhận");

  const afterSlide = await atTime(120_000, () => store.increment(key));
  assert.equal(afterSlide.totalHits, 1, "sau khi cửa sổ trượt qua hết, bộ đếm bắt đầu lại từ 1");

  await store.resetKey?.(key);
});

test("SC-2 / US-3: traffic hợp lệ rải đều (4 req/phút) trong 150s KHÔNG bị đánh dấu vượt ngưỡng", needsRedis, async () => {
  const key = testKey("us3-spread");
  const hits: number[] = [];
  for (let i = 0; i <= 10; i++) {
    hits.push((await atTime(i * 15_000, () => store.increment(key))).totalHits);
  }

  assert.equal(
    hits.filter((h) => h > MAX).length,
    0,
    `0 request được phép bị coi là vượt ngưỡng, thực tế ${hits.filter((h) => h > MAX).length} (${hits.join(",")})`
  );
  assert.ok(Math.max(...hits) <= MAX, "đỉnh bộ đếm phải nằm trong ngưỡng");
  await store.resetKey?.(key);
});

const namespaced = (inner: Store, ns: string, seen: Set<string>): Store => ({
  ...inner,
  increment: (key: string): Promise<ClientRateLimitInfo> => {
    seen.add(key);
    return Promise.resolve(inner.increment(`${ns}${key}`));
  },
  decrement: () => {},
  resetKey: (key: string) => inner.resetKey?.(`${ns}${key}`),
});

const withServer = async (app, fn: (base: string) => Promise<void>) => {
  const server = app.listen(0);
  await once(server, "listening");
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
};

test("FR-2: authRedisStore gắn vào express-rate-limit trả 200 x5 rồi 429 kèm Retry-After", needsRedis, async () => {
  const seen = new Set<string>();
  const ns = `${testKey("http")}:`;
  const httpStore = namespaced(authRedisStore, ns, seen);
  const app = express();
  app.get("/t", createRateLimiter({ windowMs: WINDOW_MS, max: MAX, store: httpStore }), (_req, res) =>
    res.json({ ok: true })
  );

  try {
    await withServer(app, async (baseUrl) => {
      for (let i = 1; i <= MAX; i++) {
        assert.equal((await fetch(`${baseUrl}/t`)).status, 200, `request ${i}/${MAX} phải qua`);
      }
      const sixth = await fetch(`${baseUrl}/t`);
      assert.equal(sixth.status, 429, "request thứ 6 phải bị chặn bởi store Redis");
      assert.ok(sixth.headers.get("retry-after"), "429 phải kèm Retry-After");
    });
  } finally {
    for (const key of seen) await httpStore.resetKey?.(key);
  }
});

test("FR-6 (cutover): authTierLimiter (singleton thật) chặn request thứ 6 bằng store Redis", needsRedis, async () => {
  const seen = new Set<string>();
  const app = express();
  app.get(
    "/t",
    (req, _res, next) => {
      seen.add(ipKeyGenerator(req.ip ?? ""));
      next();
    },
    authTierLimiter,
    (_req, res) => res.json({ ok: true })
  );

  try {
    await withServer(app, async (baseUrl) => {
      for (let i = 1; i <= MAX; i++) {
        assert.equal((await fetch(`${baseUrl}/t`)).status, 200, `request ${i}/${MAX} phải qua`);
      }
      const sixth = await fetch(`${baseUrl}/t`);
      assert.equal(sixth.status, 429, "request thứ 6 phải bị chặn bởi singleton Redis-backed");
      assert.ok(sixth.headers.get("retry-after"), "429 phải kèm Retry-After");
    });
  } finally {
    for (const key of seen) await authTierLimiter.resetKey(key);
  }
});

test("TEST-1: ZCARD khớp đúng số lần increment được chấp nhận", needsRedis, async () => {
  const key = testKey("zcard");
  assert.equal(await zcard(key), 0, "key phải sạch trước khi bắt đầu");
  for (let i = 0; i < 3; i++) await store.increment(key);
  assert.equal(await zcard(key), 3, "ZSET phải có đúng 3 phần tử sau 3 lần increment");
  await store.increment(key);
  assert.equal(await zcard(key), 4, "mỗi increment được chấp nhận thêm đúng 1 phần tử");
  await store.resetKey?.(key);
});

test("TEST-1: PEXPIRE được set sau mỗi increment (0 < PTTL ≤ windowMs) — key không rò rỉ vĩnh viễn", needsRedis, async () => {
  const key = testKey("pttl");
  await store.increment(key);
  const first = await pttl(key);
  assert.ok(first > 0, `PTTL phải > 0 sau increment đầu tiên, nhận ${first} (-1 = quên PEXPIRE)`);
  assert.ok(first <= WINDOW_MS, `PTTL không được vượt windowMs, nhận ${first}`);

  await store.increment(key);
  const second = await pttl(key);
  assert.ok(second > 0 && second <= WINDOW_MS, `PTTL phải được gia hạn ở increment kế tiếp, nhận ${second}`);
  await store.resetKey?.(key);
});

test("TEST-1: key TỰ BIẾN MẤT sau windowMs (dùng cửa sổ ngắn 300ms để quan sát thật)", needsRedis, async () => {
  const shortStore = createRedisSlidingWindowStore({ windowMs: 300, max: MAX });
  const key = testKey("expiry");
  await shortStore.increment(key);
  await shortStore.increment(key);
  assert.equal(await zcard(key), 2, "key phải tồn tại ngay sau increment");

  await delay(450);
  assert.equal(await base.exists(`${KEY_PREFIX}${key}`), 0, "key phải tự hết hạn, không cần dọn thủ công");
});

test("AD-4: 2 increment trong CÙNG 1 millisecond -> ZADD thêm 2 phần tử (member unique), không ghi đè", needsRedis, async () => {
  const key = testKey("same-ms");
  const [a, b] = await atTime(5_000, async () => [
    (await store.increment(key)).totalHits,
    (await store.increment(key)).totalHits,
  ]);

  assert.deepEqual([a, b], [1, 2], "2 lần gọi cùng millisecond phải đếm thành 2, không phải 1");
  assert.equal(await zcard(key), 2, "ZSET phải có 2 phần tử dù 2 member cùng score");
  await store.resetKey?.(key);
});

test("resetKey chỉ xoá ĐÚNG key của nó, không đụng key khác", needsRedis, async () => {
  const keyA = testKey("reset-a");
  const keyB = testKey("reset-b");
  await store.increment(keyA);
  await store.increment(keyA);
  await store.increment(keyB);

  await store.resetKey?.(keyA);
  assert.equal(await zcard(keyA), 0, "key được reset phải sạch");
  assert.equal(await zcard(keyB), 1, "key khác KHÔNG được bị ảnh hưởng");
  assert.equal((await store.increment(keyB)).totalHits, 2, "bộ đếm của key khác vẫn tiếp tục từ giá trị cũ");
  await store.resetKey?.(keyB);
});

const spyLogger = () => {
  const warn: Record<string, unknown>[] = [];
  const error: Record<string, unknown>[] = [];
  const original = { warn: logger.warn, error: logger.error };
  (logger as { warn: unknown }).warn = (payload: Record<string, unknown>) => warn.push(payload);
  (logger as { error: unknown }).error = (payload: Record<string, unknown>) => error.push(payload);
  return {
    warn,
    error,
    restore: () => {
      (logger as { warn: unknown }).warn = original.warn;
      (logger as { error: unknown }).error = original.error;
    },
  };
};

const TIMEOUT_ERR = new Error("Command timed out");
const REFUSED_ERR = new Error("connect ECONNREFUSED 127.0.0.1:6379");
const OK_RESULT: ClientRateLimitInfo = { totalHits: 3, resetTime: new Date(1_700_000_000_000) };

const makeFlakyStore = () => {
  const state: { failWith: Error | null } = { failWith: null };
  const inner: Store = {
    localKeys: false,
    increment: async () => {
      if (state.failWith) throw state.failWith;
      return OK_RESULT;
    },
    decrement: () => {},
    resetKey: async () => {},
  };
  return { state, wrapped: withFailOpen(inner) };
};

test("SC-4: 1 lỗi Redis ĐƠN LẺ -> fail-open cho request đó, log warn, KHÔNG coi Redis là down", async () => {
  const { state, wrapped } = makeFlakyStore();
  await wrapped.increment("reset-counter");

  const spy = spyLogger();
  try {
    state.failWith = TIMEOUT_ERR;
    const result = await wrapped.increment("k-single");

    assert.equal(result.totalHits, 1, "fail-open phải trả totalHits=1 (0 sẽ throw ở positiveHits validation)");
    assert.ok(result.totalHits <= MAX, "fail-open KHÔNG được khiến middleware chặn request");
    assert.equal(result.resetTime, undefined, "fail-open không bịa resetTime");

    assert.equal(spy.error.length, 0, "1 lỗi lẻ KHÔNG được trigger policy 'Redis down' (log error)");
    assert.equal(spy.warn.length, 1, "1 lỗi lẻ phải log đúng 1 warn");
    assert.equal(spy.warn[0].consecutiveFailures, 1);
    assert.equal(spy.warn[0].key, "k-single", "log phải kèm key (NFR-4 log context)");
    assert.equal(spy.warn[0].limiter, "authTierLimiter");
    assert.equal((spy.warn[0].err as Error).message, TIMEOUT_ERR.message, "log phải kèm lỗi gốc");

    state.failWith = null;
    assert.deepEqual(await wrapped.increment("k-single"), OK_RESULT, "không được stuck fail-open sau khi Redis khoẻ lại");
  } finally {
    spy.restore();
  }
});

test("SC-4: 2 lỗi LIÊN TIẾP -> fail-open cả 2 lần, lần thứ 2 log error kèm consecutiveFailures", async () => {
  const { state, wrapped } = makeFlakyStore();
  await wrapped.increment("reset-counter");

  const spy = spyLogger();
  try {
    state.failWith = REFUSED_ERR;
    const first = await wrapped.increment("k-down");
    const second = await wrapped.increment("k-down");

    assert.equal(first.totalHits, 1, "lần lỗi thứ 1 fail-open");
    assert.equal(second.totalHits, 1, "lần lỗi thứ 2 vẫn fail-open (AD-3: fail-open, KHÔNG fail-closed)");

    assert.equal(spy.warn.length, 1, "chỉ lần lỗi ĐẦU log warn");
    assert.equal(spy.error.length, 1, "lần lỗi thứ 2 (đủ debounce) phải log error");
    assert.equal(spy.error[0].consecutiveFailures, 2);
    assert.equal(spy.error[0].key, "k-down");
    assert.equal(spy.error[0].limiter, "authTierLimiter");
    assert.equal((spy.error[0].err as Error).message, REFUSED_ERR.message);
  } finally {
    spy.restore();
  }
});

test("SC-4: 1 lần THÀNH CÔNG reset consecutiveFailures — lỗi tiếp theo lại chỉ là warn (chống cold-start SKL-005)", async () => {
  const { state, wrapped } = makeFlakyStore();
  await wrapped.increment("reset-counter");

  const spy = spyLogger();
  try {
    state.failWith = REFUSED_ERR;
    await wrapped.increment("k-recover");
    await wrapped.increment("k-recover");
    assert.equal(spy.error.length, 1, "tiền đề: đã ở trạng thái down");

    state.failWith = null;
    assert.deepEqual(await wrapped.increment("k-recover"), OK_RESULT);

    state.failWith = TIMEOUT_ERR;
    await wrapped.increment("k-recover");
    assert.equal(spy.error.length, 1, "sau khi reset, 1 lỗi lẻ KHÔNG được log error lần nữa");
    assert.equal(spy.warn.length, 2, "lỗi sau khi reset phải quay lại mức warn (counter = 1)");
    assert.equal(spy.warn[1].consecutiveFailures, 1, "counter phải đã được reset về 0 rồi +1");
  } finally {
    spy.restore();
  }
});

test("SC-4: resetKey/decrement KHÔNG fail-open — lỗi phải lộ ra (không phải luồng request thật)", async () => {
  const boom = new Error("resetKey boom");
  const wrapped = withFailOpen({
    localKeys: false,
    increment: async () => OK_RESULT,
    decrement: () => {},
    resetKey: async () => {
      throw boom;
    },
  });

  await assert.rejects(() => Promise.resolve(wrapped.resetKey?.("k")), /resetKey boom/);
  await wrapped.increment("reset-counter");
});
