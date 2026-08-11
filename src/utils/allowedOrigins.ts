// Shared between the Express CORS config (app.ts) and the Socket.IO CORS
// config (socket/socket.ts) so the two never drift — a mismatch here means
// the socket handshake silently stops carrying the jwt cookie, since
// `credentials: true` requires an explicit origin list on both sides.
//
// Task 001 (security-hardening, FR-3): read from `ALLOWED_ORIGINS` env var
// (comma-separated) when set — takes priority regardless of NODE_ENV. When
// unset, fall back to the hardcoded localhost list ONLY in dev
// (`NODE_ENV === "dev"`) to keep the local dev experience unchanged;
// otherwise (e.g. `NODE_ENV=production` with no env var configured) resolve
// to an empty list so production never silently allows localhost.
export const DEV_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
];

// Pure resolver, exported separately so tests can exercise every branch with
// fake env values directly — `ALLOWED_ORIGINS` below is computed once at
// import time (ESM module cache), so it can't be re-derived per test case.
export const resolveAllowedOrigins = (
  rawOrigins: string | undefined,
  nodeEnv: string | undefined
): string[] =>
  rawOrigins
    ? rawOrigins
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean)
    : nodeEnv === "dev"
      ? DEV_ORIGINS
      : [];

const ALLOWED_ORIGINS = resolveAllowedOrigins(
  process.env.ALLOWED_ORIGINS,
  process.env.NODE_ENV
);

export default ALLOWED_ORIGINS;
