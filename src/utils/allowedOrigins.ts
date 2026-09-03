export const DEV_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
];

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
