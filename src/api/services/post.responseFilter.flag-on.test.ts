// Run with Node's built-in test runner: `npm test`.
//
// Phạm vi (task 010 — FR-1/scenario 1, FR-4, FR-6): `getPostDetail` end-to-end với flag
// `POST_RESPONSE_FIELD_FILTER_ENABLED=true`.
//
// `POST_CONFIG` đọc `process.env` đúng 1 lần lúc `services/config.ts` được import rồi
// `Object.freeze` — phải set env TRƯỚC mọi import chạm tới nó (qua `post.ts`). `node --test` chạy
// mỗi file test trong 1 process riêng nên set ở đây KHÔNG rò sang file test khác — cùng lý do và
// cùng pattern với `controllers/post.controller.dispatch.enabled-false.test.ts`.
//
// QUAN TRỌNG: import TĨNH bị hoist lên TRƯỚC dòng `process.env...` bên dưới, bất kể thứ tự viết
// trong file — nên MỌI import chạm tới `post.ts`/`config.ts` phải là `await import(...)` động bên
// trong test. Chỉ import tĩnh những module KHÔNG chạm tới config (`node:test`, model, Constants).
process.env.POST_RESPONSE_FIELD_FILTER_ENABLED = "true";

import assert from "node:assert/strict";
import { test } from "node:test";
import { Constants } from "../../Breads-Shared/Constants/index.js";
import Post from "../models/post.model.ts";

const POST_ID = "652f1b2c3d4e5f6071829304";
const AUTHOR_ID = "652f1b2c3d4e5f6071829305";

/** Post "rỗng tối đa": mọi field optional ở giá trị rỗng, và cả 2 field required cũng rỗng — để
 * chứng minh required KHÔNG bị lược ngay cả khi flag ON (NFR-3). */
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
  likesCount: 0,
  repliesCount: 0,
  authorInfo: { _id: AUTHOR_ID, username: "duc" },
});

const stubAggregate = (docs: any[]) => {
  const original = (Post as any).aggregate;
  (Post as any).aggregate = async (pipeline: any[]) =>
    JSON.stringify(pipeline).includes("$group") ? [] : docs;
  return () => {
    (Post as any).aggregate = original;
  };
};

const OPTIONAL_EMPTY_KEYS = [
  "survey",
  "files",
  "usersTag",
  "links",
  "linksInfo",
  "quote",
];

test("precondition: env override có hiệu lực, flag ON", async () => {
  const { POST_CONFIG } = await import("./config.ts");
  assert.equal(POST_CONFIG.responseFieldFilterEnabled, true);
});

test("FR-1/scenario 1: flag ON -> usersTag/links/linksInfo (và survey/files/quote) rỗng bị xoá khỏi response", async () => {
  const { getPostDetail } = await import("./post.ts");
  const restore = stubAggregate([emptyishPost()]);
  try {
    const detail: any = await getPostDetail({ postId: POST_ID });
    for (const key of OPTIONAL_EMPTY_KEYS) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(detail, key),
        false,
        `flag ON: field optional rỗng \`${key}\` phải bị xoá`,
      );
    }
  } finally {
    restore();
  }
});

test("NFR-3: flag ON -> field required (content, media) rỗng vẫn có mặt; field không-rỗng không đổi", async () => {
  const { getPostDetail } = await import("./post.ts");
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

test("FR-1: flag ON nhưng field optional CÓ dữ liệu -> không bị xoá", async () => {
  const { getPostDetail } = await import("./post.ts");
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

test("FR-4: flag ON -> `__v` vẫn bị xoá", async () => {
  const { getPostDetail } = await import("./post.ts");
  const restore = stubAggregate([emptyishPost()]);
  try {
    const detail: any = await getPostDetail({ postId: POST_ID });
    assert.equal(Object.prototype.hasOwnProperty.call(detail, "__v"), false);
  } finally {
    restore();
  }
});

test("FR-6: nhánh bulk (GET feed gọi lại `getPostDetail({postIds})`) nhận CÙNG shape đã lọc", async () => {
  const { getPostDetail } = await import("./post.ts");
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
