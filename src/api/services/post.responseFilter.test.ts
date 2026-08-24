// Run with Node's built-in test runner: `npm test`. Cùng quy ước với `postVisibility.test.ts`.
//
// Phạm vi (task 010 — FR-1, FR-4): bước lọc field rỗng tại `getPostDetail`, điểm serialize DÙNG
// CHUNG của `GET post detail`, `GET feed` và endpoint collection (ARCH-1).
//
// File này chạy với flag ở trạng thái MẶC ĐỊNH (OFF — không set env) và phủ:
//   - `stripEmptyOptionalFields` như HÀM THUẦN, truyền thẳng tham số `filterEnabled` cho cả 2 nhánh
//     (không phải cache-bust module ESM — cùng lý do `config.test.ts` test `boolFlag` trực tiếp).
//   - `getPostDetail` end-to-end với flag OFF: KHÔNG regression, mọi field rỗng vẫn còn.
// Nhánh flag ON end-to-end nằm ở `post.responseFilter.flag-on.test.ts` (phải set env trước import).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Constants } from "../../Breads-Shared/Constants/index.js";
import Post from "../models/post.model.ts";
import {
  REQUIRED_POST_FIELDS,
  getPostDetail,
  stripEmptyOptionalFields,
} from "./post.ts";
import { POST_CONFIG } from "./config.ts";

const POST_ID = "652f1b2c3d4e5f6071829304";
const AUTHOR_ID = "652f1b2c3d4e5f6071829305";

/** Post "rỗng tối đa": mọi field optional đều ở giá trị rỗng, kể cả field required (`content`,
 * `media`) — để chứng minh required KHÔNG bị lược kể cả khi rỗng. */
const emptyishPost = () => ({
  _id: POST_ID,
  __v: 0,
  authorId: AUTHOR_ID,
  visibility: Constants.POST_VISIBILITY.PUBLIC,
  status: Constants.POST_STATUS.PUBLIC,
  content: "", // required, rỗng -> PHẢI giữ
  media: [], // required, rỗng -> PHẢI giữ
  survey: [], // optional (T1/001)
  files: [], // optional (T1/001)
  usersTag: [],
  links: [],
  linksInfo: [],
  quote: {},
  likesCount: 0,
  repliesCount: 0,
  authorInfo: { _id: AUTHOR_ID, username: "duc" },
});

/** Stub `Post.aggregate` cho đúng 2 lần gọi trong `getPostDetail`: pipeline chính (trả post) và
 * pipeline đếm repost (`$group`). Trả về hàm restore. */
const stubAggregate = (docs: any[]) => {
  const original = (Post as any).aggregate;
  (Post as any).aggregate = async (pipeline: any[]) =>
    JSON.stringify(pipeline).includes("$group") ? [] : docs;
  return () => {
    (Post as any).aggregate = original;
  };
};

/* ---------------- Hàm thuần `stripEmptyOptionalFields` ---------------- */

test("REQUIRED_POST_FIELDS chốt đúng PRD (Constraints): chỉ content + media", () => {
  assert.deepEqual([...REQUIRED_POST_FIELDS].sort(), ["content", "media"]);
});

test("FR-1: flag ON -> field optional rỗng ([], '', {}) bị xoá", () => {
  const result = stripEmptyOptionalFields(
    { usersTag: [], links: [], linksInfo: [], quote: {}, share: "" },
    true,
  );
  assert.deepEqual(Object.keys(result), []);
});

test("FR-1/NFR-3: flag ON -> field REQUIRED rỗng vẫn được giữ nguyên", () => {
  const result = stripEmptyOptionalFields({ content: "", media: [] }, true);
  assert.deepEqual(result, { content: "", media: [] });
});

test("FR-1: flag ON -> field KHÔNG rỗng giữ nguyên, kể cả giá trị falsy không-rỗng", () => {
  const input = {
    usersTag: ["u1"],
    likesCount: 0, // số 0 KHÔNG phải "rỗng"
    likedByMe: false, // boolean false KHÔNG phải "rỗng"
    parentPost: null, // null KHÔNG phải "rỗng" (không bị xoá)
    authorInfo: { _id: "u1" },
  };
  assert.deepEqual(stripEmptyOptionalFields(input, true), input);
});

test("FR-1: flag OFF -> giữ nguyên hành vi cũ, không field rỗng nào bị xoá", () => {
  const input = { usersTag: [], links: [], quote: {}, content: "", media: [] };
  assert.deepEqual(stripEmptyOptionalFields(input, false), input);
});

test("FR-4: `__v` LUÔN bị xoá, bất kể flag ON hay OFF", () => {
  for (const flag of [true, false]) {
    const result = stripEmptyOptionalFields({ __v: 7, content: "x" }, flag);
    assert.equal(
      Object.prototype.hasOwnProperty.call(result, "__v"),
      false,
      `__v phải bị xoá khi flag=${flag}`,
    );
    assert.equal(result.content, "x");
  }
});

test("stripEmptyOptionalFields không mutate input (trả bản copy)", () => {
  const input: any = { __v: 0, usersTag: [], content: "x" };
  stripEmptyOptionalFields(input, true);
  assert.equal(input.__v, 0);
  assert.deepEqual(input.usersTag, []);
});

test("mặc định `filterEnabled` lấy từ POST_CONFIG (T3/003), không phải hằng số cứng", () => {
  const result = stripEmptyOptionalFields({ usersTag: [] });
  assert.equal(
    Object.prototype.hasOwnProperty.call(result, "usersTag"),
    !POST_CONFIG.responseFieldFilterEnabled,
  );
});

/* ---------------- `getPostDetail` end-to-end, flag OFF (mặc định) ---------------- */

test("FR-1/scenario 2: flag OFF -> getPostDetail giữ NGUYÊN mọi field rỗng (không regression)", async () => {
  assert.equal(
    POST_CONFIG.responseFieldFilterEnabled,
    false,
    "precondition: file này phải chạy với flag mặc định OFF",
  );
  const restore = stubAggregate([emptyishPost()]);
  try {
    const detail: any = await getPostDetail({ postId: POST_ID });
    for (const key of ["survey", "files", "usersTag", "links", "linksInfo", "quote"]) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(detail, key),
        true,
        `flag OFF: field rỗng \`${key}\` phải còn nguyên trong response`,
      );
    }
    assert.equal(detail.content, "");
    assert.deepEqual(detail.media, []);
    // Field enrich vẫn được gắn bình thường sau bước lọc.
    assert.equal(detail.repostNum, 0);
    assert.equal(detail.likedByMe, false);
  } finally {
    restore();
  }
});

test("FR-4/scenario: flag OFF -> response getPostDetail vẫn KHÔNG chứa `__v`", async () => {
  const restore = stubAggregate([emptyishPost()]);
  try {
    const detail: any = await getPostDetail({ postId: POST_ID });
    assert.equal(Object.prototype.hasOwnProperty.call(detail, "__v"), false);
  } finally {
    restore();
  }
});

test("FR-4: nhánh bulk (feed dùng chung `getPostDetail({postIds})`) cũng bị lọc `__v`", async () => {
  const restore = stubAggregate([emptyishPost()]);
  try {
    const list: any[] = await getPostDetail({ postIds: [POST_ID] });
    assert.equal(list.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(list[0], "__v"), false);
    assert.equal(list[0]._id, POST_ID);
  } finally {
    restore();
  }
});
