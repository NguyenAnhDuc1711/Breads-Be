// Run with Node's built-in test runner: `npm test`.
//
// Phạm vi: Task 011 (unified-payload-sanitize, FR-2/NFR-1) — xác nhận HTTP API
// (`express-mongo-sanitize`, dùng ở 8 router) và socket layer (`sanitizeNoSqlPayload`
// từ Task 001) strip CÙNG một tập key nguy hiểm, cho ra CÙNG kết quả. Đây KHÔNG phải
// test hành vi bên trong 2 hàm (đã có test riêng: sanitize.test.ts cho mongoSanitize,
// và test của Task 001 cho sanitizeNoSqlPayload) mà là test tương đương giữa 2 hàm,
// theo AD-2 (epic context): HTTP router giữ nguyên express-mongo-sanitize, không thay
// bằng hàm dùng chung — "hợp nhất" được verify bằng test hành vi, không phải code sharing.
import assert from "node:assert/strict";
import { test } from "node:test";
import mongoSanitize from "express-mongo-sanitize";
import { sanitizeNoSqlPayload } from "./sanitize.js";

const maliciousInputs: unknown[] = [
  { $gt: "" },
  { "a.b": 1 },
  { nested: { $where: "evil" } },
  { safe: "value", $ne: null },
];

const safeInputs: unknown[] = [
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
