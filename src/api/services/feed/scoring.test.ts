import { test } from "node:test";
import assert from "node:assert/strict";
import { bucketedNow, hotScore, relevanceScore, finalScore, rankCandidates } from "./scoring.ts";

const T = Date.parse("2026-01-01T00:00:00.000Z");
const HOUR = 3_600_000;

test("decay ratio at 6h/12h/48h (SC-4)", () => {
  const base = hotScore(100, T, T);
  assert.equal(base, 100);

  const at6h = hotScore(100, T, T + 6 * HOUR);
  assert.ok(Math.abs(at6h / base - 0.5) < 1e-9, `expected ~0.5, got ${at6h / base}`);

  const at12h = hotScore(100, T, T + 12 * HOUR);
  assert.ok(Math.abs(at12h / base - 0.25) < 1e-9, `expected ~0.25, got ${at12h / base}`);

  const at48h = hotScore(100, T, T + 48 * HOUR);
  assert.ok(at48h / base <= 0.1, `expected <= 0.1, got ${at48h / base}`);
});

test("hotScore coerces undefined/null/'abc'/NaN to 0 (FAIL-3)", () => {
  for (const bad of [undefined, null, "abc", NaN]) {
    const s = hotScore(bad, T, T);
    assert.equal(s, 0);
    assert.equal(Number.isNaN(s), false);
  }
});

test("hotScore clamps negative engagementScore to 0", () => {
  assert.equal(hotScore(-50, T, T), 0);
});

test("hotScore does not exceed base for future createdAt", () => {
  assert.equal(hotScore(100, T + 10 * HOUR, T), 100);
});

test("rankCandidates survives mixed undefined/negative/valid engagementScore (FAIL-3 comparator)", () => {
  const posts = [
    { _id: "a", engagementScore: undefined, categories: [], createdAt: T },
    { _id: "b", engagementScore: -10, categories: [], createdAt: T },
    { _id: "c", engagementScore: 1000, categories: [], createdAt: T },
    { _id: "d", engagementScore: NaN, categories: [], createdAt: T },
    { _id: "e", engagementScore: 50, categories: [], createdAt: T },
  ];
  const ranked = rankCandidates(posts, [], T);
  assert.equal(ranked.length, posts.length);
  assert.ok(ranked.every((p) => p !== undefined));
  assert.equal(ranked[0]._id, "c");
});

test("finalScore respects alpha/beta blend from FEED_CONFIG", async () => {
  const { FEED_CONFIG } = await import("./config.ts");
  const post = { categories: [], engagementScore: undefined, createdAt: T };
  const relevance = 0;
  const hot = 10;
  const expected = FEED_CONFIG.alpha * relevance + FEED_CONFIG.beta * hot;
  const engagementForHot10 = hot;
  const score = finalScore({ ...post, engagementScore: engagementForHot10 }, [], T);
  assert.equal(score, expected);
});

test("rankCandidates is a total order (shuffle-invariant tie-break)", () => {
  const base = [
    { _id: "x1", engagementScore: 10, categories: [], createdAt: T },
    { _id: "x2", engagementScore: 10, categories: [], createdAt: T },
    { _id: "x3", engagementScore: 10, categories: [], createdAt: T },
  ];
  const shuffled = [base[2], base[0], base[1]];

  const order1 = rankCandidates(base, [], T).map((p) => p._id);
  const order2 = rankCandidates(shuffled, [], T).map((p) => p._id);
  assert.deepEqual(order1, order2);
  assert.deepEqual(order1, ["x1", "x2", "x3"]);
});

test("bucketedNow floors to bucket boundary", () => {
  const t = Date.parse("2026-01-01T00:00:00.000Z");
  assert.equal(bucketedNow(t, 60), bucketedNow(t + 30_000, 60));
  assert.notEqual(bucketedNow(t, 60), bucketedNow(t + 61_000, 60));
  assert.equal(bucketedNow(t, 60) % 60_000, 0);
});

test("relevanceScore counts matched categories x 15, tolerates empty", () => {
  assert.equal(relevanceScore(["a", "b"], ["a", "b"]), 30);
  assert.equal(relevanceScore(["a"], ["b"]), 0);
  assert.equal(relevanceScore([], ["a"]), 0);
  assert.equal(relevanceScore(undefined, ["a"]), 0);
  assert.equal(relevanceScore(["a"], undefined), 0);
  assert.equal(relevanceScore(undefined, undefined), 0);
});
