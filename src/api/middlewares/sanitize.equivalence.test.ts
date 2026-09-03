import assert from "node:assert/strict";
import { test } from "node:test";
import mongoSanitize from "express-mongo-sanitize";
import { sanitizeNoSqlPayload } from "./sanitize.js";

const maliciousInputs: Record<string, unknown>[] = [
  { $gt: "" },
  { "a.b": 1 },
  { nested: { $where: "evil" } },
  { safe: "value", $ne: null },
];

const safeInputs: Record<string, unknown>[] = [
  { name: "Nguyễn Văn Ánh", bio: "yêu đời! #vibe @all 100%" },
  { nested: { safe: "value", count: 2 } },
];

test("FR-2: input chứa key nguy hiểm ($gt/a.b/$where lồng nhau/$ne) bị strip GIỐNG NHAU bởi express-mongo-sanitize và sanitizeNoSqlPayload", () => {
  for (const input of maliciousInputs) {
    const viaMongoSanitize = mongoSanitize.sanitize(structuredClone(input));
    const viaSharedFn = sanitizeNoSqlPayload(structuredClone(input));
    assert.deepStrictEqual(
      viaMongoSanitize,
      viaSharedFn,
      `kết quả strip phải deep-equal cho input: ${JSON.stringify(input)}`
    );
  }
});

test("FR-2 (negative case): input KHÔNG có key nguy hiểm thì cả 2 hàm đều giữ nguyên, không strip nhầm", () => {
  for (const input of safeInputs) {
    const viaMongoSanitize = mongoSanitize.sanitize(structuredClone(input));
    const viaSharedFn = sanitizeNoSqlPayload(structuredClone(input));
    assert.deepStrictEqual(viaMongoSanitize, input, "mongoSanitize không được strip nhầm input hợp lệ");
    assert.deepStrictEqual(viaSharedFn, input, "sanitizeNoSqlPayload không được strip nhầm input hợp lệ");
    assert.deepStrictEqual(
      viaMongoSanitize,
      viaSharedFn,
      `kết quả phải deep-equal cho input hợp lệ: ${JSON.stringify(input)}`
    );
  }
});
