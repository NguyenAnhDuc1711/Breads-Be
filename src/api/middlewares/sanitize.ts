
export const sanitizeText = (val?: string | null): string => {
  if (!val || typeof val !== "string") return "";
  return val
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .trim();
};

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
      continue;
    }
    cleanObj[key] = sanitizeNoSqlPayload(value);
  }

  return cleanObj as T;
};
