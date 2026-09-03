// Run with Node's built-in test runner: `npm test`.
//
// Phạm vi: bước 5 (epic access-control-hardening) — validate `dateRange` của snapshot analytics.
//
// Chỉ import hàm THUẦN `parseSnapshotDateRange`, không import listener/controller thật: file đó kéo
// theo `getCollection` (cần Mongo) và `User` model. Guard role của listener được kiểm bằng test
// wiring đọc source bên dưới, cùng cách `post.route.test.ts` kiểm wiring.
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import {
  MAX_SNAPSHOT_RANGE_DAYS,
  parseSnapshotDateRange,
} from "./analytics.controller.ts";

test("parseSnapshotDateRange: khoảng hợp lệ trong trần -> ok", () => {
  const r = parseSnapshotDateRange(["2026-08-01", "2026-08-31"]);
  assert.equal(r.ok, true);
  assert.deepEqual(r, { ok: true, fromDate: "2026-08-01", toDate: "2026-08-31" });
});

test("parseSnapshotDateRange: cùng một ngày = 1 ngày, không phải 0 -> ok", () => {
  assert.equal(parseSnapshotDateRange(["2026-08-01", "2026-08-01"]).ok, true);
});

// Ranh giới: đúng 90 ngày phải qua, 91 ngày phải chặn. Off-by-one ở đây là loại lỗi âm thầm —
// không ai phát hiện cho tới khi một khoảng hợp lệ bị từ chối trong lúc demo.
test(`parseSnapshotDateRange: đúng ${MAX_SNAPSHOT_RANGE_DAYS} ngày -> ok, ${MAX_SNAPSHOT_RANGE_DAYS + 1} ngày -> lỗi`, () => {
  const start = new Date("2026-01-01T00:00:00.000Z");
  const at = (days: number) =>
    new Date(start.getTime() + (days - 1) * 86_400_000).toISOString().slice(0, 10);

  assert.equal(parseSnapshotDateRange(["2026-01-01", at(MAX_SNAPSHOT_RANGE_DAYS)]).ok, true);
  const tooLong = parseSnapshotDateRange(["2026-01-01", at(MAX_SNAPSHOT_RANGE_DAYS + 1)]);
  assert.equal(tooLong.ok, false);
});

// Chính là payload probe V6 dùng để nạp cả collection vào RAM.
test("parseSnapshotDateRange: khoảng nhiều năm bị chặn", () => {
  const r = parseSnapshotDateRange(["2000-01-01", "2030-01-01"]);
  assert.equal(r.ok, false);
});

test("parseSnapshotDateRange: from > to bị chặn", () => {
  assert.equal(parseSnapshotDateRange(["2026-08-31", "2026-08-01"]).ok, false);
});

// Đây là các payload TỪNG ném TypeError ngoài khối try -> unhandledRejection toàn cục.
for (const bad of [undefined, null, [], ["2026-08-01"], "2026-08-01", {}, ["x", "y"]]) {
  test(`parseSnapshotDateRange: payload dị dạng ${JSON.stringify(bad)} -> lỗi, không throw`, () => {
    let result: any;
    assert.doesNotThrow(() => {
      result = parseSnapshotDateRange(bad as any);
    });
    assert.equal(result.ok, false);
  });
}

/* ------------------------------------------------- wiring (đọc source, không import) */

test("Bước 5 (wiring): admin.listener.ts guard role trước khi gọi getSnapshotReport", async () => {
  const src = await fs.readFile("src/socket/listeners/admin.listener.ts", "utf8");
  const code = src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

  assert.ok(
    code.includes("hasSnapshotAccess(socket)"),
    "listener phải kiểm quyền trước khi phục vụ"
  );
  const guardIdx = code.indexOf("hasSnapshotAccess(socket)");
  const callIdx = code.indexOf("AnalyticsController.getSnapshotReport");
  assert.ok(guardIdx !== -1 && callIdx !== -1);
  assert.ok(
    guardIdx < callIdx,
    "guard phải chạy TRƯỚC khi gọi controller, không phải sau"
  );
  assert.ok(
    code.includes("USER_ROLE.ADMIN") && code.includes("USER_ROLE.MODERATOR"),
    "danh sách role phải tường minh trong source"
  );
});
