// Run with Node's built-in test runner: `npm test`.
//
// Phạm vi (task 010 — FR-6 / ARCH-1): endpoint saved-posts (`removePostFromCollection`) là
// consumer THỨ BA của `getPostDetail`, ngoài `GET post detail` và `GET feed`. Checklist của 010
// yêu cầu verify RIÊNG response của endpoint này, không chỉ suy luận "vì dùng chung hàm nên chắc
// đúng" — đây chính là loại giả định mà ARCH-1 cảnh báo.
//
// Phát hiện khi viết test này: `collection.controller.ts:69` gọi `getPostDetail(id)` (truyền thẳng
// id) trong khi hàm nhận 1 OBJECT tham số -> `postId` destructure ra `undefined` -> `ObjectId("")`
// sinh id NGẪU NHIÊN -> endpoint LUÔN trả mảng toàn `null`, bug tiền hữu. Đã sửa call site thành
// `getPostDetail({ postId: id })`; test dưới đây vừa là bằng chứng FR-6 vừa là regression cho bug đó.
//
// Env phải set TRƯỚC mọi import chạm `services/config.ts` (qua controller -> `post.ts`) — xem
// comment dài ở `post.controller.dispatch.enabled-false.test.ts`, cùng pattern.
process.env.POST_RESPONSE_FIELD_FILTER_ENABLED = "true";

import assert from "node:assert/strict";
import { test } from "node:test";
import { Constants } from "../../Breads-Shared/Constants/index.js";
import Post from "../models/post.model.ts";
import SavedPost from "../models/savedPost.model.ts";

const POST_ID = "652f1b2c3d4e5f6071829304";
const AUTHOR_ID = "652f1b2c3d4e5f6071829305";
const USER_ID = "652f1b2c3d4e5f6071829306";

const emptyishPost = () => ({
  _id: POST_ID,
  __v: 0,
  authorId: AUTHOR_ID,
  visibility: Constants.POST_VISIBILITY.PUBLIC,
  status: Constants.POST_STATUS.PUBLIC,
  content: "",
  media: [],
  survey: [],
  files: [],
  usersTag: [],
  links: [],
  linksInfo: [],
  quote: {},
  authorInfo: { _id: AUTHOR_ID, username: "duc" },
});

/** Stub tầng model theo pattern của `post.controller.test.ts` (gán đè property trên object đã
 * import, restore trong `finally`): `SavedPost.deleteOne`/`.find` cho controller +
 * `getPostsIdByFilter`, `Post.aggregate` cho `getPostDetail`. */
const stubModels = () => {
  const originals = {
    deleteOne: (SavedPost as any).deleteOne,
    find: (SavedPost as any).find,
    aggregate: (Post as any).aggregate,
  };
  (SavedPost as any).deleteOne = async () => ({ deletedCount: 1 });
  (SavedPost as any).find = () => {
    const chain: any = {
      sort: () => chain,
      skip: () => chain,
      limit: () => chain,
      then: (resolve: any) => resolve([{ postId: POST_ID }]),
    };
    return chain;
  };
  (Post as any).aggregate = async (pipeline: any[]) =>
    JSON.stringify(pipeline).includes("$group") ? [] : [emptyishPost()];
  return () => {
    (SavedPost as any).deleteOne = originals.deleteOne;
    (SavedPost as any).find = originals.find;
    (Post as any).aggregate = originals.aggregate;
  };
};

const fakeRes = () => ({
  _status: 0,
  _body: null as any,
  status(code: number) {
    this._status = code;
    return this;
  },
  json(body: any) {
    this._body = body;
    return this;
  },
});

test("FR-6 (ARCH-1): response endpoint collection cũng đi qua bước lọc field rỗng khi flag ON", async () => {
  const { POST_CONFIG } = await import("../services/config.ts");
  assert.equal(POST_CONFIG.responseFieldFilterEnabled, true, "precondition: flag ON");
  const { removePostFromCollection } = await import("./collection.controller.ts");

  const restore = stubModels();
  const res: any = fakeRes();
  try {
    await removePostFromCollection(
      { params: { userId: USER_ID, postId: POST_ID } },
      res,
    );
  } finally {
    restore();
  }

  const metadata = res._body?.metadata;
  assert.ok(Array.isArray(metadata), "metadata phải là mảng post detail");
  // Regression bug tiền hữu: trước khi sửa call site, phần tử này luôn là `null`.
  assert.equal(metadata.length, 1);
  const detail = metadata[0];
  assert.ok(detail, "post detail không được là null (call site phải truyền { postId })");

  for (const key of ["survey", "files", "usersTag", "links", "linksInfo", "quote", "__v"]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(detail, key),
      false,
      `collection endpoint: \`${key}\` phải bị lọc y hệt post detail / feed`,
    );
  }
  // NFR-3: field required không được biến mất ở endpoint này.
  assert.equal(detail.content, "");
  assert.deepEqual(detail.media, []);
  assert.equal(detail._id, POST_ID);
});
