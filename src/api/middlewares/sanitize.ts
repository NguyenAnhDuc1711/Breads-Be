/**
 * Shared sanitize utilities used by BOTH the `src/api/` layer (Express
 * middleware/validator) and the `src/socket/` layer (Socket.IO). Not
 * API-only despite living under `src/api/middlewares/`.
 */

/**
 * Remove dangerous script tags, null bytes, and control characters from text.
 */
export const sanitizeText = (val?: string | null): string => {
  if (!val || typeof val !== "string") return "";
  return val
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .trim();
};

/**
 * Recursively sanitize objects by removing keys that start with '$' or contain '.'
 * to prevent NoSQL operator injection.
 */
export const sanitizeNoSqlPayload = <T>(input: T): T => {
  if (input === null || typeof input !== "object") {
    return input;
  }

  if (Array.isArray(input)) {
    return input.map((item) => sanitizeNoSqlPayload(item)) as unknown as T;
  }

  const cleanObj: Record<string, any> = {};
  for (const [key, value] of Object.entries(input as Record<string, any>)) {
    if (key.startsWith("$") || key.includes(".")) {
      continue; // Strip MongoDB operator key
    }
    cleanObj[key] = sanitizeNoSqlPayload(value);
  }

  return cleanObj as T;
};
