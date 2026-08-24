// Run with Node's built-in test runner: `npm test`.
//
// Phạm vi (task 020, NFR-3): contract test Ở TẦNG CONTROLLER cho `GET post detail`
// (`getPost` trong `post.controller.ts`) — nơi client THẬT SỰ nhận response (PRD Risk #4:
// `IPost` có thể lệch schema Mongoose thực tế, rủi ro nằm ở tầng shape response chứ không chỉ
// ở hàm service nội bộ). Bổ sung cho `post.responseFilter*.test.ts` (010) — 2 file đó gọi thẳng
// `stripEmptyOptionalFields`/`getPostDetail` (tầng service); file này gọi `getPost(req, res)`,
// đúng hàm mà router `GET /posts/:id` dispatch tới, và kiểm tra `res._body.metadata` — object
// envelope thật (`OK` trong `core/success.response.ts`) mà client nhận qua HTTP.
//
// Dùng ĐÚNG `REQUIRED_POST_FIELDS` export từ `services/post.ts` làm nguồn duy nhất — không
// hard-code lại danh sách field required (cảnh báo ở handoff #010), nếu không contract test sẽ
// không bắt được lỗi khi danh sách đó bị đổi.
//
// Env phải set TRƯỚC mọi import chạm `services/config.ts` (qua `post.controller.ts` ->
// `services/post.ts`) — cùng pattern `collection.controller.filter.test.ts` /
// `post.controller.dispatch.enabled-false.test.ts`. Import TĨNH bị hoist lên trước dòng
// `process.env...` bất kể thứ tự viết trong file, nên mọi import chạm `post.controller.ts`/
// `services/post.ts`/`services/config.ts` phải là `await import(...)` động bên trong test —
// KỂ CẢ `services/feed/queue.ts` (`closeFanoutQueues`), vì nó import `fanout.ts` ->
// `services/post.ts` -> `services/config.ts` bắc cầu, nên import tĩnh sẽ load `config.ts` (đọc
// `POST_CONFIG` cố định) SỚM hơn dòng set env bên dưới nếu không cẩn thận.
process.env.POST_RESPONSE_FIELD_FILTER_ENABLED = "true";

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Constants } from "../../Breads-Shared/Constants/index.js";
import Post from "../models/post.model.ts";

const POST_ID = "652f1b2c3d4e5f6071829304";
const AUTHOR_ID = "652f1b2c3d4e5f6071829305";

/** Post "rỗng tối đa": mọi field optional rỗng, và cả field required cũng ở giá trị rỗng-hợp-lệ
 * — đúng kịch bản NFR-3 (required không được biến mất dù rỗng). Cùng shape với
 * `post.responseFilter.flag-on.test.ts` để 2 tầng test (service/controller) khảo cùng 1 input. */
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

test("NFR-3 (controller layer, GET post detail): field required (từ T1/001, REQUIRED_POST_FIELDS) luôn có mặt trong metadata response dù giá trị rỗng, flag ON", async () => {
  const { POST_CONFIG } = await import("../services/config.ts");
  assert.equal(POST_CONFIG.responseFieldFilterEnabled, true, "precondition: flag ON");
  const { REQUIRED_POST_FIELDS } = await import("../services/post.ts");
  const { getPost } = await import("./post.controller.ts");

  const restore = stubAggregate([emptyishPost()]);
  const res: any = fakeRes();
  try {
    await getPost({ params: { id: POST_ID }, viewerId: null }, res);
  } finally {
    restore();
  }

  assert.equal(res._status, 200);
  const metadata = res._body?.metadata;
  assert.ok(metadata, "metadata (post detail) không được rỗng");
  for (const field of REQUIRED_POST_FIELDS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(metadata, field),
      true,
      `field required \`${field}\` phải có mặt trong response ngay cả khi rỗng (NFR-3)`,
    );
  }
  assert.equal(metadata.content, "");
  assert.deepEqual(metadata.media, []);
});

test("FR-1 (controller layer, GET post detail): field optional rỗng bị lược khỏi metadata response, flag ON", async () => {
  const { getPost } = await import("./post.controller.ts");

  const restore = stubAggregate([emptyishPost()]);
  const res: any = fakeRes();
  try {
    await getPost({ params: { id: POST_ID }, viewerId: null }, res);
  } finally {
    restore();
  }

  const metadata = res._body?.metadata;
  for (const field of ["survey", "files", "usersTag", "links", "linksInfo", "quote", "__v"]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(metadata, field),
      false,
      `field optional rỗng \`${field}\` phải bị lược khỏi response (khẳng định filter hoạt động đúng, không chỉ "không xoá nhầm")`,
    );
  }
});

after(async () => {
  const { closeFanoutQueues } = await import("../services/feed/queue.ts");
  await closeFanoutQueues();
});
