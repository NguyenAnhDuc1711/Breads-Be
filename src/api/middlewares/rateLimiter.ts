import type { Request } from "express";
import rateLimit from "express-rate-limit";
import type { Store } from "express-rate-limit";
import { authRedisStore } from "./rateLimitRedisStore.ts";

export const createRateLimiter = ({
  windowMs,
  max,
  message,
  skip,
  store,
}: {
  windowMs: number;
  max: number;
  message?: string;
  skip?: (req: Request) => boolean;
  store?: Store;
}) =>
  rateLimit({
    windowMs,
    max,
    message: message ?? "Too many requests, please try again later",
    standardHeaders: true,
    legacyHeaders: false,
    ...(skip ? { skip } : {}),
    ...(store ? { store } : {}),
  });

const AUTH_TIER_WINDOW_MS = 60_000;
const AUTH_TIER_MAX = 5;

export const authTierLimiter = createRateLimiter({
  windowMs: AUTH_TIER_WINDOW_MS,
  max: AUTH_TIER_MAX,
  store: authRedisStore,
});

const SITEMAP_ELIGIBLE_PATHS = new Set([
  "/posts/sitemap-eligible",
  "/users/sitemap-eligible",
]);

export const globalTierLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 100,
  skip: (req) => SITEMAP_ELIGIBLE_PATHS.has(req.path),
});

export const mediaSignLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });
