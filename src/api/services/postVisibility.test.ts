// Run with Node's built-in test runner: `npm test`. Cùng quy ước với `feed/scoring.test.ts`
// (không thêm dependency mới, Node tự strip type của `.ts`).
//
// Phạm vi: quy tắc quan hệ AD-2 dùng chung ở cả 5 read-path (FR-4..FR-7). Repo chưa có harness
// Mongo cho integration test, nên ở đây kiểm chứng phần THUẦN của quy tắc:
//   - `canViewPost`: hàm thuần, không chạm DB — phủ đủ FR-4..FR-7.
//   - `buildVisibilityQuery`: truyền sẵn `followeeIds` để hàm không query `Follow` -> vẫn thuần.
// Nhánh còn lại (áp query vào từng read-path) phải verify bằng tay/E2E, xem handoff.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Constants } from "../../Breads-Shared/Constants/index.js";
import { buildVisibilityQuery, canViewPost, filterViewablePosts } from "./post.ts";

const { PUBLIC: V_PUBLIC, ONLY_FOLLOWERS, ONLY_ME } = Constants.POST_VISIBILITY;
const { PRE_ACCEPT, PUBLIC: S_PUBLIC, DELETED } = Constants.POST_STATUS;

const AUTHOR = "652f1b2c3d4e5f6071829304";
const VIEWER = "652f1b2c3d4e5f6071829305";

const post = (over: any = {}) => ({
  authorId: AUTHOR,
  visibility: V_PUBLIC,
  status: S_PUBLIC,
  ...over,
});

test("FR-4: viewer không follow author -> không xem được ONLY_FOLLOWERS / ONLY_ME", () => {
  assert.equal(canViewPost(VIEWER, post({ visibility: ONLY_FOLLOWERS }), false), false);
  assert.equal(canViewPost(VIEWER, post({ visibility: ONLY_ME }), false), false);
  assert.equal(canViewPost(VIEWER, post({ visibility: V_PUBLIC }), false), true);
});

test("FR-4 regression (Critical Issue #1 / AD-5): PRE_ACCEPT của NGƯỜI KHÁC vẫn xem được nếu visibility cho phép", () => {
  assert.equal(
    canViewPost(VIEWER, post({ status: PRE_ACCEPT, visibility: V_PUBLIC }), false),
    true,
  );
  assert.equal(
    canViewPost(VIEWER, post({ status: PRE_ACCEPT, visibility: ONLY_FOLLOWERS }), true),
    true,
  );
});

test("FR-5: follow author -> thấy ONLY_FOLLOWERS, KHÔNG thấy ONLY_ME", () => {
  assert.equal(canViewPost(VIEWER, post({ visibility: ONLY_FOLLOWERS }), true), true);
  assert.equal(canViewPost(VIEWER, post({ visibility: ONLY_ME }), true), false);
});

test("FR-6: tác giả xem bài của chính mình -> thấy mọi visibility, trừ DELETED", () => {
  for (const visibility of [V_PUBLIC, ONLY_FOLLOWERS, ONLY_ME]) {
    assert.equal(canViewPost(AUTHOR, post({ visibility }), false), true);
    assert.equal(
      canViewPost(AUTHOR, post({ visibility, status: PRE_ACCEPT }), false),
      true,
    );
  }
  assert.equal(canViewPost(AUTHOR, post({ status: DELETED }), false), false);
});

test("DELETED bị loại với mọi viewer, mọi visibility", () => {
  assert.equal(canViewPost(VIEWER, post({ status: DELETED }), true), false);
  assert.equal(
    canViewPost(VIEWER, post({ status: DELETED, visibility: V_PUBLIC }), true),
    false,
  );
});

test("FR-7: viewer ẩn danh (viewerId=null) chỉ thấy PUBLIC", () => {
  assert.equal(canViewPost(null, post({ visibility: V_PUBLIC }), false), true);
  assert.equal(canViewPost(null, post({ visibility: ONLY_FOLLOWERS }), true), false);
  assert.equal(canViewPost(null, post({ visibility: ONLY_ME }), false), false);
});

test("post thiếu `visibility` được coi như PUBLIC (mặc định schema)", () => {
  assert.equal(canViewPost(VIEWER, post({ visibility: undefined }), false), true);
});

test("buildVisibilityQuery: ẩn danh -> đúng 1 nhánh PUBLIC + loại DELETED", async () => {
  const query: any = await buildVisibilityQuery(null);
  assert.deepEqual(query.status, { $ne: DELETED });
  assert.equal(query.$or.length, 1);
  assert.deepEqual(query.$or[0], { visibility: V_PUBLIC });
});

test("buildVisibilityQuery: có viewer + followee -> 3 nhánh (PUBLIC / tự mình / ONLY_FOLLOWERS)", async () => {
  const query: any = await buildVisibilityQuery(VIEWER, [AUTHOR]);
  assert.equal(query.$or.length, 3);
  assert.deepEqual(query.$or[0], { visibility: V_PUBLIC });
  assert.equal(String(query.$or[1].authorId), VIEWER);
  assert.equal(query.$or[2].visibility, ONLY_FOLLOWERS);
  assert.deepEqual(query.$or[2].authorId.$in, [AUTHOR]);
  // KHÔNG có nhánh nào cho ONLY_ME của người khác.
  assert.equal(
    query.$or.some((clause: any) => clause.visibility === ONLY_ME),
    false,
  );
});

test("buildVisibilityQuery: viewer không follow ai -> bỏ hẳn nhánh ONLY_FOLLOWERS", async () => {
  const query: any = await buildVisibilityQuery(VIEWER, []);
  assert.equal(query.$or.length, 2);
  assert.equal(
    query.$or.some((clause: any) => clause.visibility === ONLY_FOLLOWERS),
    false,
  );
});

test("buildVisibilityQuery KHÔNG loại PRE_ACCEPT (AD-5)", async () => {
  const query: any = await buildVisibilityQuery(VIEWER, []);
  assert.deepEqual(query.status, { $ne: DELETED });
  assert.equal(JSON.stringify(query).includes(`"$nin"`), false);
});

// Task 090 fix / GAP-1 (epic-verify Phase A): `getPostDetail({getFullInfo:true})` nhúng sẵn
// `replies` của mỗi post — bản gốc chỉ lọc visibility ở top-level, không lọc lại từng reply theo
// visibility CỦA CHÍNH REPLY ĐÓ (reply có thể tự đổi visibility riêng sau khi tạo, khác bài gốc).
// Hậu quả live-tested: 1 reply ONLY_ME lộ nguyên văn qua GET /posts/:id cho viewer bất kỳ. Test
// này tái tạo đúng kịch bản đó bằng `filterViewablePosts` (hàm được tái dùng để vá) — không dùng
// ONLY_FOLLOWERS nên không chạm `Follow.find`/DB, giữ đúng tinh thần "hàm thuần" của file này.
test("Task 090 regression: filterViewablePosts lọc đúng reply ONLY_ME của người khác trong mảng replies nhúng sẵn", async () => {
  const replies = [
    { _id: "r1", authorId: AUTHOR, visibility: V_PUBLIC },
    { _id: "r2", authorId: AUTHOR, visibility: ONLY_ME }, // reply riêng tư của người khác -> phải bị lọc
    { _id: "r3", authorId: VIEWER, visibility: ONLY_ME }, // reply ONLY_ME của chính viewer -> phải giữ
  ];
  const result = await filterViewablePosts(replies, VIEWER);
  assert.deepEqual(
    result.map((r: any) => r._id).sort(),
    ["r1", "r3"],
  );
});

test("filterViewablePosts: mảng rỗng trả về rỗng, không query Follow", async () => {
  assert.deepEqual(await filterViewablePosts([], VIEWER), []);
});

test("filterViewablePosts: tác giả tự xem mảng reply của chính mình -> thấy hết kể cả ONLY_ME", async () => {
  const replies = [
    { _id: "r1", authorId: VIEWER, visibility: ONLY_ME },
    { _id: "r2", authorId: VIEWER, visibility: V_PUBLIC },
  ];
  const result = await filterViewablePosts(replies, VIEWER);
  assert.equal(result.length, 2);
});
