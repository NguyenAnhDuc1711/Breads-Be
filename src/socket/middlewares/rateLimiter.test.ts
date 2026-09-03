import { test } from "node:test";
import assert from "node:assert/strict";
import { SocketRateLimiter } from "./rateLimiter.js";

test("SocketRateLimiter: allows requests within max limit", () => {
  const limiter = new SocketRateLimiter("test_limiter", {
    windowMs: 1000,
    max: 3,
  });

  const res1 = limiter.check("user1");
  const res2 = limiter.check("user1");
  const res3 = limiter.check("user1");

  assert.equal(res1.allowed, true);
  assert.equal(res2.allowed, true);
  assert.equal(res3.allowed, true);

  limiter.destroy();
});

test("SocketRateLimiter: blocks requests exceeding limit and returns retryAfterMs", () => {
  const limiter = new SocketRateLimiter("test_limiter", {
    windowMs: 1000,
    max: 2,
  });

  limiter.check("user1");
  limiter.check("user1");
  const blocked = limiter.check("user1");

  assert.equal(blocked.allowed, false);
  assert.equal(typeof blocked.retryAfterMs, "number");
  assert.ok(blocked.retryAfterMs! > 0);

  const resOther = limiter.check("user2");
  assert.equal(resOther.allowed, true);

  limiter.destroy();
});

test("SocketRateLimiter: reset clears user limits", () => {
  const limiter = new SocketRateLimiter("test_limiter", {
    windowMs: 1000,
    max: 1,
  });

  limiter.check("user1");
  assert.equal(limiter.check("user1").allowed, false);

  limiter.reset("user1");
  assert.equal(limiter.check("user1").allowed, true);

  limiter.destroy();
});
