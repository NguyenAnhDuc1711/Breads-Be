// Run with Node's built-in test runner: `npm test`.
//
// Phạm vi: CHỈ cổng FR-8 (`visibility === ONLY_ME` -> 0 ZSET write). Đây là nhánh duy nhất của
// `fanoutPostToFollowers` chạy được mà không cần Mongo/Redis, vì nó return TRƯỚC `User.findOne`.
// Các nhánh còn lại (celebrity, fan-out thật) chạm DB nên phải verify bằng smoke test tay — repo
// chưa có harness Mongo cho integration test, xem handoff.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Constants } from "../../../Breads-Shared/Constants/index.js";
import PostConstants from "../../../Breads-Shared/Constants/PostConstants.js";
import { fanoutPostToFollowers } from "./fanout.ts";

const captureLogs = async (fn: () => Promise<void>): Promise<any[]> => {
  const logs: any[] = [];
  const original = console.log;
  console.log = (...args: any[]) => {
    if (args[0] === "[feed-fanout]") logs.push(args[1]);
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return logs;
};

const onlyMePost = {
  _id: "652f1b2c3d4e5f6071829304",
  authorId: "652f1b2c3d4e5f6071829305",
  type: PostConstants.ACTIONS.CREATE,
  visibility: Constants.POST_VISIBILITY.ONLY_ME,
  createdAt: new Date(),
};

test("FR-8: bài ONLY_ME -> fan-out ghi log zadds=0 và không chạm DB", async () => {
  const logs = await captureLogs(() => fanoutPostToFollowers({ post: onlyMePost }));
  assert.equal(logs.length, 1);
  assert.equal(logs[0].zadds, 0);
  assert.equal(logs[0].onlyMe, true);
  assert.equal(logs[0].postId, String(onlyMePost._id));
});

test("FR-8: cổng ONLY_ME return trước mọi truy vấn (không treo dù không có Mongo/Redis)", async () => {
  // Nếu cổng bị đặt sai chỗ (sau `User.findOne`), test này sẽ timeout thay vì pass ngay.
  const t0 = Date.now();
  await fanoutPostToFollowers({ post: onlyMePost });
  assert.ok(Date.now() - t0 < 1000, "phải return ngay, không đợi truy vấn nào");
});
