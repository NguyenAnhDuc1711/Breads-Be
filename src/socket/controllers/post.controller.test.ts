// Run with Node's built-in test runner: `npm test`.
//
// Phạm vi: Task 012 (FR-4/A12b) — `deleteLikeNotification`, tách khỏi `likePost` trong
// `post.controller.ts`.
//
// `likePost` gọi `getCollection(Model.POST)` (`src/utils/index.ts`), hàm này throw khi
// `mongoose.connection.db` rỗng -> `likePost` KHÔNG thể chạy end-to-end trong test suite (không có
// harness Mongo, NFR-2 cấm thêm dependency). Vì vậy file này gọi THẲNG `deleteLikeNotification`,
// không bao giờ gọi `likePost` — cùng lý do `post.controller.dispatch.test.ts` tách test khỏi
// `createPost` để chạm `dispatchFanout` trực tiếp.
//
// ⚠️ TEST-2/TEST-7: việc tách hàm sinh một seam mới giữa `likePost` và `deleteLikeNotification` —
// R-11 phát tác đúng ở seam này (nếu call site truyền nhầm biến, `deleteLikeNotification` vẫn xanh
// 100% khi test trực tiếp, trong khi unlike ngoài đời xoá 0 document). Test đọc source bên dưới
// assert DANH TÍNH giá trị truyền vào (`postInfo.authorId`, cho phép bọc `ObjectId(...)`), KHÔNG
// cấm cách viết `ObjectId(...)`/`String(...)` — Mongoose cast filter theo schema nên hai cách viết
// cho cùng kết quả (pattern đọc source: `notification.route.test.ts:116-120`,
// `bodyLimit.route.test.ts:263-277`).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import mongoose from "mongoose";
import Notification from "../../api/models/notification.model.ts";
import { Constants } from "../../Breads-Shared/Constants/index.ts";
import { deleteLikeNotification } from "./post.controller.ts";

const withStubbedModel = async (
  stubs: Array<[any, string, any]>,
  fn: () => Promise<void> | void
) => {
  const originals: Array<[any, string, any]> = stubs.map(([obj, prop]) => [
    obj,
    prop,
    obj[prop],
  ]);
  for (const [obj, prop, replacement] of stubs) {
    obj[prop] = replacement;
  }
  try {
    return await fn();
  } finally {
    for (const [obj, prop, original] of originals) {
      obj[prop] = original;
    }
  }
};

const FROM_USER = "652f1b2c3d4e5f6071829301";
const TO_USER = "652f1b2c3d4e5f6071829302";
const POST_1 = "652f1b2c3d4e5f6071829303";
const POST_2 = "652f1b2c3d4e5f6071829304";

test("FR-4: A12b - deleteLikeNotification -> filter đủ fromUser + toUsers.$in + action:\"like\" + target", async () => {
  let deleteOneCalls = 0;
  let capturedFilter: any;

  await withStubbedModel(
    [
      [
        Notification,
        "deleteOne",
        async (filter: any) => {
          deleteOneCalls++;
          capturedFilter = filter;
        },
      ],
    ],
    async () => {
      await deleteLikeNotification({
        fromUserId: FROM_USER,
        toUserId: TO_USER,
        postId: POST_1,
      });
    }
  );

  assert.equal(deleteOneCalls, 1);
  assert.ok(Object.hasOwn(capturedFilter, "fromUser"));
  assert.ok(Object.hasOwn(capturedFilter, "toUsers"));
  assert.ok(Object.hasOwn(capturedFilter, "action"));
  assert.ok(Object.hasOwn(capturedFilter, "target"));
  assert.equal(String(capturedFilter.fromUser), String(new mongoose.Types.ObjectId(FROM_USER)));
  assert.deepEqual(capturedFilter.toUsers, { $in: [TO_USER] });
  assert.equal(capturedFilter.action, Constants.NOTIFICATION_ACTION.LIKE);
  assert.equal(String(capturedFilter.target), String(new mongoose.Types.ObjectId(POST_1)));
});

test("FR-4: A12b - đổi postId -> filter.target đổi tương ứng (P1 ≠ P2)", async () => {
  const filters: any[] = [];

  await withStubbedModel(
    [
      [
        Notification,
        "deleteOne",
        async (filter: any) => {
          filters.push(filter);
        },
      ],
    ],
    async () => {
      await deleteLikeNotification({
        fromUserId: FROM_USER,
        toUserId: TO_USER,
        postId: POST_1,
      });
      await deleteLikeNotification({
        fromUserId: FROM_USER,
        toUserId: TO_USER,
        postId: POST_2,
      });
    }
  );

  assert.equal(filters.length, 2);
  assert.notEqual(String(filters[0].target), String(filters[1].target));
  assert.equal(String(filters[0].target), String(new mongoose.Types.ObjectId(POST_1)));
  assert.equal(String(filters[1].target), String(new mongoose.Types.ObjectId(POST_2)));
});

test('FR-4: A12b - filter chứa action "like" -> notification FOLLOW cùng cặp không khớp', async () => {
  let capturedFilter: any;

  await withStubbedModel(
    [
      [
        Notification,
        "deleteOne",
        async (filter: any) => {
          capturedFilter = filter;
        },
      ],
    ],
    async () => {
      await deleteLikeNotification({
        fromUserId: FROM_USER,
        toUserId: TO_USER,
        postId: POST_1,
      });
    }
  );

  assert.equal(capturedFilter.action, "like");
  assert.notEqual(capturedFilter.action, Constants.NOTIFICATION_ACTION.FOLLOW);

  // Một notification FOLLOW cùng cặp (from, to) không khớp filter vì action khác — mô phỏng bằng
  // cách kiểm tra document FOLLOW giả không thoả điều kiện `action` của filter.
  const followNotification = {
    fromUser: FROM_USER,
    toUsers: [TO_USER],
    action: Constants.NOTIFICATION_ACTION.FOLLOW,
    target: undefined,
  };
  assert.notEqual(followNotification.action, capturedFilter.action);
});

test("FR-4: A12b - toUserId là ObjectId (driver thô) -> filter giữ đúng giá trị", async () => {
  let capturedFilter: any;
  const rawObjectId = new mongoose.Types.ObjectId(TO_USER);

  await withStubbedModel(
    [
      [
        Notification,
        "deleteOne",
        async (filter: any) => {
          capturedFilter = filter;
        },
      ],
    ],
    async () => {
      await deleteLikeNotification({
        fromUserId: FROM_USER,
        toUserId: rawObjectId,
        postId: POST_1,
      });
    }
  );

  assert.equal(capturedFilter.toUsers.$in[0], rawObjectId);
  assert.equal(String(capturedFilter.toUsers.$in[0]), String(rawObjectId));
});

test("FR-4: A12b - deleteOne gọi 1 lần, findOne 0 lần", async () => {
  let deleteOneCalls = 0;
  let findOneCalls = 0;

  await withStubbedModel(
    [
      [
        Notification,
        "deleteOne",
        async () => {
          deleteOneCalls++;
        },
      ],
      [
        Notification,
        "findOne",
        async () => {
          findOneCalls++;
          return null;
        },
      ],
    ],
    async () => {
      await deleteLikeNotification({
        fromUserId: FROM_USER,
        toUserId: TO_USER,
        postId: POST_1,
      });
    }
  );

  assert.equal(deleteOneCalls, 1);
  assert.equal(findOneCalls, 0);
});

test("FR-4: A12b seam - call site truyền postInfo.authorId vào toUserId (không phải userId) — đọc source", async () => {
  const src = await fs.readFile(
    "src/socket/controllers/post.controller.ts",
    "utf8"
  );

  assert.match(
    src,
    /toUserId:\s*(?:ObjectId\()?postInfo\.authorId\)?/,
    "call site phải truyền postInfo.authorId vào toUserId (cho phép bọc ObjectId(...))"
  );
  assert.doesNotMatch(
    src,
    /toUserId:\s*userId/,
    "call site KHÔNG được truyền userId vào toUserId — nhầm biến sẽ làm filter khớp sai chiều"
  );
  assert.doesNotMatch(
    src,
    /toUserId:\s*postInfo\._id/,
    "call site KHÔNG được truyền postInfo._id (id của post, không phải author) vào toUserId"
  );
});

test("FR-3: $project nhánh LIKE chứa $ifNull cho isRead", async () => {
  const src = await fs.readFile(
    "src/socket/controllers/post.controller.ts",
    "utf8"
  );

  assert.match(
    src,
    /isRead:\s*\{\s*\$ifNull:\s*\[\s*"\$isRead",\s*false\s*\]\s*\}/,
    "$project của aggregate nhánh LIKE phải chứa isRead: { $ifNull: [\"$isRead\", false] }"
  );
  assert.doesNotMatch(
    src,
    /isRead:\s*1/,
    "không được dùng isRead: 1 — aggregate bỏ qua default Mongoose, sẽ bỏ hẳn key trên document cũ thiếu field"
  );
});
