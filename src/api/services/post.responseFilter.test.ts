// Run with Node's built-in test runner: `npm test`. Cùng quy ước với `postVisibility.test.ts`.
//
// Phạm vi (task 010 — FR-1, FR-4, FR-6): bước lọc field rỗng tại `getPostDetail`, điểm serialize
// DÙNG CHUNG của `GET post detail`, `GET feed` và endpoint collection (ARCH-1). Luôn chạy vô điều
// kiện — không còn feature flag (rollout flag T3/003 đã bị bỏ, xem PRD Constraints).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Constants } from "../../Breads-Shared/Constants/index.js";
import Post from "../models/post.model.ts";
import {
  REQUIRED_POST_FIELDS,
  getPostDetail,
  stripEmptyOptionalFields,
} from "./post.ts";

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

const OPTIONAL_EMPTY_KEYS = [
  "survey",
  "files",
  "usersTag",
  "links",
  "linksInfo",
  "quote",
];

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

test("FR-1: field optional rỗng ([], '', {}) bị xoá", () => {
  const result = stripEmptyOptionalFields({
    usersTag: [],
    links: [],
    linksInfo: [],
    quote: {},
    share: "",
  });
  assert.deepEqual(Object.keys(result), []);
});

test("FR-1/NFR-3: field REQUIRED rỗng vẫn được giữ nguyên", () => {
  const result = stripEmptyOptionalFields({ content: "", media: [] });
  assert.deepEqual(result, { content: "", media: [] });
});

test("FR-1: field KHÔNG rỗng giữ nguyên, kể cả giá trị falsy không-rỗng", () => {
  const input = {
    usersTag: ["u1"],
    likesCount: 0, // số 0 KHÔNG phải "rỗng"
    likedByMe: false, // boolean false KHÔNG phải "rỗng"
    parentPost: null, // null KHÔNG phải "rỗng" (không bị xoá)
    authorInfo: { _id: "u1" },
  };
  assert.deepEqual(stripEmptyOptionalFields(input), input);
});

test("FR-4: `__v` luôn bị xoá", () => {
  const result = stripEmptyOptionalFields({ __v: 7, content: "x" });
  assert.equal(Object.prototype.hasOwnProperty.call(result, "__v"), false);
  assert.equal(result.content, "x");
});

test("stripEmptyOptionalFields không mutate input (trả bản copy)", () => {
  const input: any = { __v: 0, usersTag: [], content: "x" };
  stripEmptyOptionalFields(input);
  assert.equal(input.__v, 0);
  assert.deepEqual(input.usersTag, []);
});

/* ---------------- `getPostDetail` end-to-end ---------------- */

test("FR-1/scenario: getPostDetail xoá field optional rỗng khỏi response", async () => {
  const restore = stubAggregate([emptyishPost()]);
  try {
    const detail: any = await getPostDetail({ postId: POST_ID });
    for (const key of OPTIONAL_EMPTY_KEYS) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(detail, key),
        false,
        `field optional rỗng \`${key}\` phải bị xoá`,
      );
    }
  } finally {
    restore();
  }
});

test("NFR-3: field required (content, media) rỗng vẫn có mặt; field không-rỗng không đổi", async () => {
  const restore = stubAggregate([emptyishPost()]);
  try {
    const detail: any = await getPostDetail({ postId: POST_ID });
    assert.equal(detail.content, "", "content required, rỗng -> vẫn phải có");
    assert.deepEqual(detail.media, [], "media required, rỗng -> vẫn phải có");
    // Giá trị falsy nhưng KHÔNG rỗng phải sống sót, nếu không consumer sẽ mất counter.
    assert.equal(detail.likesCount, 0);
    assert.equal(detail.repliesCount, 0);
    assert.equal(detail.repostNum, 0);
    assert.equal(detail.likedByMe, false);
    assert.deepEqual(detail.authorInfo, { _id: AUTHOR_ID, username: "duc" });
  } finally {
    restore();
  }
});

test("FR-1: field optional CÓ dữ liệu -> không bị xoá", async () => {
  const restore = stubAggregate([
    { ...emptyishPost(), links: ["l1"], survey: [{ _id: "s1", value: "a" }] },
  ]);
  try {
    const detail: any = await getPostDetail({ postId: POST_ID });
    assert.deepEqual(detail.links, ["l1"]);
    assert.equal(detail.survey.length, 1);
    // usersTag vẫn rỗng -> vẫn bị xoá (chỉ field RỖNG mới bị lược).
    assert.equal(Object.prototype.hasOwnProperty.call(detail, "usersTag"), false);
  } finally {
    restore();
  }
});

test("FR-4/scenario: response getPostDetail không chứa `__v`", async () => {
  const restore = stubAggregate([emptyishPost()]);
  try {
    const detail: any = await getPostDetail({ postId: POST_ID });
    assert.equal(Object.prototype.hasOwnProperty.call(detail, "__v"), false);
  } finally {
    restore();
  }
});

test("FR-6: nhánh bulk (GET feed dùng lại `getPostDetail({postIds})`) nhận CÙNG shape đã lọc", async () => {
  const restore = stubAggregate([emptyishPost()]);
  try {
    const list: any[] = await getPostDetail({ postIds: [POST_ID] });
    assert.equal(list.length, 1, "post vẫn phải còn trong danh sách sau khi lọc");
    for (const key of [...OPTIONAL_EMPTY_KEYS, "__v"]) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(list[0], key),
        false,
        `bulk/feed: \`${key}\` phải bị xoá y như nhánh single`,
      );
    }
    assert.equal(list[0].content, "");
    assert.deepEqual(list[0].media, []);
  } finally {
    restore();
  }
});
