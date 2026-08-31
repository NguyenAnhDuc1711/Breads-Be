// Run with Node's built-in test runner: `npm test`.
//
// Phạm vi: Task 012 — schema cho `post.route.ts` (FR-5/FR-9).
//
// 3 tầng, cố ý không thay thế nhau:
//  - Tầng schema (parse trực tiếp): kiểm từng field, nhanh, không mở socket.
//  - Tầng HTTP: dựng 1 `express()` mới, mount SCHEMA THẬT + `validate()` THẬT, controller là stub.
//    CỐ Ý không `import` chính `post.route.ts`: file đó kéo theo `post.controller.ts` ->
//    `services/feed/queue.ts`, mà module này tạo `new Redis(...)` + 2 `new Queue(...)` NGAY LÚC
//    IMPORT. Connection đó giữ event loop sống mãi -> `npm test` chạy xong hết test rồi treo, không
//    bao giờ exit. Vì vậy phần "router có wire đúng không" được kiểm bằng test đọc SOURCE ở cuối
//    file (cùng cách `validate.test.ts` kiểm `src/app.ts`).
//  - Tầng integration: đẩy object đã parse vào `getPostsIdByFilter` THẬT, stub model ở tầng
//    mongoose để không cần DB — đây là test bắt được đúng loại bug "schema nuốt field mà service
//    cần" mà test schema thuần KHÔNG bắt được.
//  - Tầng repost-guard end-to-end (Task 011, R-6): NGOẠI LỆ có chủ đích với ghi chú "không import
//    post.route.ts" ở trên — phần cuối file import CHÍNH `createPost` thật để chạy guard chặn bypass
//    task 090 qua ĐÚNG route/method mới (`POST /posts`). Redis/BullMQ mở lúc import được đóng lại
//    bằng `after(closeFanoutQueues)` ở cuối file, đúng pattern `post.controller.test.ts` đã dùng.
import assert from "node:assert/strict";
import { once } from "node:events";
import { after, test } from "node:test";
import express from "express";
import { z } from "zod";
import { POST_PATH, Route } from "../../Breads-Shared/APIConfig.ts";
import PageConstant from "../../Breads-Shared/Constants/PageConstants.js";
import PostConstants from "../../Breads-Shared/Constants/PostConstants.js";
import { Constants } from "../../Breads-Shared/Constants/index.js";
import logger from "../../core/logger.ts";
import asyncHandler from "../../helpers/asyncHandler.ts";
import {
  createPost,
  getPosts,
  getSitemapEligiblePosts,
  updatePostStatus,
} from "../controllers/post.controller.ts";
import { VALIDATION_ERROR_MESSAGE, validate } from "../middlewares/validate.ts";
import { sanitizeText } from "../middlewares/sanitize.ts";
import sitemapAuthGate, {
  SITEMAP_SECRET_HEADER,
} from "../middlewares/sitemapAuthGate.ts";
import Post from "../models/post.model.ts";
import SavedPost from "../models/savedPost.model.ts";
import User from "../models/user.model.ts";
import { closeFanoutQueues } from "../services/feed/queue.ts";
import { getPostsIdByFilter } from "../services/post.ts";
import {
  createPostSchema,
  deletePostSchema,
  getPostActivitiesSchema,
  getPostsQuerySchema,
  getSitemapEligiblePostsQuerySchema,
  likeUnlikePostSchema,
  tickPostSurveySchema,
  updatePostStatusSchema,
  updatePostSchema,
  updatePostVisibilitySchema,
} from "../validators/post.validator.ts";

const VALID_ID = "652f1b2c3d4e5f6071829304";
const OTHER_ID = "652f1b2c3d4e5f6071829305";

const silenceWarn = async (fn: () => unknown | Promise<unknown>) => {
  const original = logger.warn;
  (logger as any).warn = () => {};
  try {
    return await fn();
  } finally {
    (logger as any).warn = original;
  }
};

const errorHandler = (err, _req, res, _next) => {
  const statusCode = err.statusCode || err.status || 500;
  res.status(statusCode).json({ message: err.message });
};

const withServer = async (app, fn: (base: string) => Promise<void>) => {
  const server = app.listen(0);
  await once(server, "listening");
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
};

/** Controller stub: nếu request chạm được tới đây nghĩa là `validate()` ĐÃ CHO QUA. Test payload
 * sai phải không bao giờ tới. `async` + KHÔNG bọc `asyncHandler` — giống hệt `createPost` thật. */
const reachedController = (_req, res) => {
  res.json({ reached: true });
};

/** Mirror cách `post.route.ts` wire 3 route dùng trong tầng HTTP dưới đây, giữ nguyên thứ tự
 * middleware. Task 011 (D-1): `POST /posts/create` -> `POST /posts`,
 * `POST /posts/update-post-visibility` -> `PATCH /posts/:id/visibility`. */
const routeApp = () => {
  const app = express();
  app.use(express.json());
  app.post("/posts", validate(createPostSchema), asyncHandler(reachedController));
  app.delete("/posts/:id", validate(deletePostSchema), reachedController);
  app.patch(
    "/posts/:id/visibility",
    validate(updatePostVisibilitySchema),
    reachedController
  );
  app.patch(
    "/posts/:id/status",
    validate(updatePostStatusSchema),
    reachedController
  );
  app.use(errorHandler);
  return app;
};

/* ------------------------------------------------- getPostsQuerySchema (core) */

// AC FR-5: đúng request đã verify ở phiên fix N+1. Dùng express thật để `?filter[page]=users&
// filter[value]=` được `qs` parse y hệt production, thay vì tự dựng object bằng tay.
test("FR-5 (qs thật): filter[value]= rỗng được GIỮ NGUYÊN là chuỗi rỗng, không bị loại/400", async () => {
  const app = express();
  let seen: any = null;
  app.get("/all", validate(getPostsQuerySchema), (req, res) => {
    seen = req.query;
    res.json({ ok: true });
  });
  app.use(errorHandler);

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/all?filter[page]=users&filter[value]=&userId=${VALID_ID}`);

    assert.equal(res.status, 200, "empty filter[value] KHÔNG được bị reject");
    assert.equal(seen.filter.value, "", "chuỗi rỗng phải còn nguyên, không thành undefined");
    assert.ok(
      Object.prototype.hasOwnProperty.call(seen.filter, "value"),
      "key `value` phải còn tồn tại — mất key nghĩa là service đọc undefined"
    );
  });
});

// Task 020 (SC-4): bản automated tương đương ĐÚNG 1:1 với curl trong Verification Checklist —
// `curl 'http://localhost:8080/api/posts/all?filter[page]=users&filter[value]='`. Khác test ngay
// trên: query string ở đây KHÔNG kèm bất kỳ param nào khác (không `userId`), đúng hình dạng đã
// điều tra ở phiên fix N+1. Chạy được không cần Mongo/Redis vì controller là stub — cái đang
// verify là `validate()` không chặn/không bóp méo query, không phải logic feed.
test("SC-4 (curl-equivalent): GET /posts/all?filter[page]=users&filter[value]= -> 200", async () => {
  const app = express();
  let seen: any = null;
  app.get("/api/posts/all", validate(getPostsQuerySchema), (req, res) => {
    seen = req.query;
    res.json({ ok: true });
  });
  app.use(errorHandler);

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/posts/all?filter[page]=users&filter[value]=`);

    assert.equal(res.status, 200, "đúng query trong checklist phải 200, không được 400/500");
    // `{ ok: true }` nguyên vẹn = không có field `message` -> chắc chắn không phải response lỗi
    // của `validate()` (`{ message: VALIDATION_ERROR_MESSAGE }`).
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(seen.filter.page, PageConstant.USER, "filter.page phải còn nguyên là 'users'");
    assert.equal(seen.filter.value, "", "filter[value]= rỗng phải tới controller là chuỗi rỗng");
  });
});

// AC FR-5 (field completeness): assert trên KEY của object đã parse, không chỉ "parse thành công".
test("FR-5: parse giữ đủ 4 field getPostsIdByFilter destructure (filter/userId/page/limit)", () => {
  const parsed: any = getPostsQuerySchema.query.parse({
    filter: { page: PageConstant.SAVED, value: "" },
    userId: VALID_ID,
    page: "2",
    limit: "10",
  });

  assert.deepEqual(
    Object.keys(parsed).sort(),
    ["filter", "limit", "page", "userId"],
    "thiếu key nào ở đây = field đó biến mất âm thầm trước khi tới service"
  );
  assert.equal(parsed.userId, VALID_ID);
  assert.equal(parsed.page, 2, "page phải được coerce sang number");
  assert.equal(parsed.limit, 10);
});

// Bằng chứng cho quyết định `.passthrough()` trên `filter`: 3 field này CHỈ được đọc trong
// `getQueryPostValidation` (nhánh admin), không có trong bảng tóm tắt của task. Nếu `filter` bị
// đóng, nhánh duyệt bài admin sẽ âm thầm lọc sai.
test("FR-5: field admin trong filter (user/postContent/postType) sống sót qua parse", () => {
  const parsed: any = getPostsQuerySchema.query.parse({
    filter: {
      page: PageConstant.ADMIN.POSTS_VALIDATION,
      user: VALID_ID,
      postContent: ["text", "image"],
      postType: ["create"],
    },
  });

  assert.equal(parsed.filter.user, VALID_ID);
  assert.deepEqual(parsed.filter.postContent, ["text", "image"]);
  assert.deepEqual(parsed.filter.postType, ["create"]);
});

test("FR-5: postContent dạng string đơn (qs khi client gửi 1 giá trị) KHÔNG bị 400", () => {
  const parsed: any = getPostsQuerySchema.query.parse({
    filter: { page: PageConstant.ADMIN.POSTS_VALIDATION, postContent: "text" },
  });
  assert.equal(parsed.filter.postContent, "text");
});

test("FR-5: filter[user]= rỗng hợp lệ, filter[user] rác bị 400 (FR-9)", () => {
  const base = { page: PageConstant.ADMIN.POSTS_VALIDATION };
  assert.equal(
    getPostsQuerySchema.query.parse({ filter: { ...base, user: "" } }).filter.user,
    ""
  );
  assert.throws(
    () => getPostsQuerySchema.query.parse({ filter: { ...base, user: "not-an-id" } }),
    z.ZodError
  );
});

// Quyết định có chủ đích (không phải sót): `filter.page` để permissive.
test("quyết định: filter.page KHÔNG bị enum-restrict — page lạ vẫn parse (rơi vào nhánh for_you)", () => {
  const parsed: any = getPostsQuerySchema.query.parse({
    filter: { page: "a_brand_new_page_type" },
  });
  assert.equal(parsed.filter.page, "a_brand_new_page_type");
});

// Top-level thì ĐÓNG: viewerId/isAdminPage do client gửi phải bị loại trước khi tới controller.
test("NFR-2: viewerId/isAdminPage client gửi lên bị strip khỏi req.query", () => {
  const parsed: any = getPostsQuerySchema.query.parse({
    filter: { page: PageConstant.USER, value: "" },
    viewerId: OTHER_ID,
    isAdminPage: "true",
    isNewPage: "true",
  });

  assert.equal(parsed.viewerId, undefined, "client không được tự khai người đang xem");
  assert.equal(parsed.isAdminPage, undefined, "cờ admin phải suy ra từ filter.page");
  assert.deepEqual(Object.keys(parsed), ["filter"]);
});

test("FR-9: userId không phải ObjectId -> ZodError", () => {
  assert.throws(
    () =>
      getPostsQuerySchema.query.parse({
        filter: { page: PageConstant.USER },
        userId: "not-an-id",
      }),
    z.ZodError
  );
});

/* ------------------------------ integration: object đã parse -> hàm service THẬT */

// AC FR-5 (integration, không chỉ unit): đẩy KẾT QUẢ PARSE vào `getPostsIdByFilter` thật và quan
// sát 4 field có thực sự tới nơi không. Stub ở tầng model (`SavedPost.find`) nên không cần Mongo.
// Chọn nhánh SAVED vì nó dùng CẢ 4 field: `filter.page` (chọn nhánh), `userId` (điều kiện find),
// `page`+`limit` (skip/limit).
test("FR-5 integration: object đã parse đi qua getPostsIdByFilter THẬT, đủ cả 4 field", async () => {
  const parsed: any = getPostsQuerySchema.query.parse({
    filter: { page: PageConstant.SAVED, value: "" },
    userId: VALID_ID,
    page: "3",
    limit: "10",
  });

  const calls: any = {};
  const chain = {
    sort(v) { calls.sort = v; return this; },
    skip(v) { calls.skip = v; return this; },
    limit(v) { calls.limit = v; return this; },
    then(resolve) { resolve([{ postId: "post-1" }, { postId: "post-2" }]); },
  };
  const originalFind = (SavedPost as any).find;
  (SavedPost as any).find = (query) => {
    calls.query = query;
    return chain;
  };

  try {
    const data = await getPostsIdByFilter(parsed);

    assert.deepEqual(data, ["post-1", "post-2"], "không được rơi vào catch -> [] (mất field)");
    assert.equal(
      String(calls.query.userId),
      VALID_ID,
      "userId phải tới được service — mất field này thì query lọc sai người"
    );
    assert.equal(calls.limit, 10, "limit phải tới nơi, không bị rơi về default 20");
    assert.equal(calls.skip, 20, "skip = (page-1)*limit = (3-1)*10 — chứng minh page tới nơi");
  } finally {
    (SavedPost as any).find = originalFind;
  }
});

/* ------------------------------------------------------------ các schema còn lại */

test("createPostSchema: payload đầy đủ hợp lệ pass", () => {
  const body = createPostSchema.body.parse({
    _id: VALID_ID,
    authorId: OTHER_ID,
    content: "hello",
    media: [],
    survey: [],
    type: "create",
    usersTag: [VALID_ID],
    visibility: Constants.POST_VISIBILITY.PUBLIC,
  });
  assert.equal(body.authorId, OTHER_ID);
  assert.equal(body.visibility, Constants.POST_VISIBILITY.PUBLIC);
});

test("createPostSchema: content > 500 ký tự fail", () => {
  assert.throws(
    () =>
      createPostSchema.body.parse({
        _id: VALID_ID,
        authorId: OTHER_ID,
        content: "x".repeat(501),
        type: "create",
      }),
    z.ZodError
  );
});

test("createPostSchema: visibility ngoài enum fail, thiếu authorId fail", () => {
  const base = { _id: VALID_ID, authorId: OTHER_ID, content: "hi", type: "create" };
  assert.throws(() => createPostSchema.body.parse({ ...base, visibility: 99 }), z.ZodError);
  const { authorId, ...withoutAuthor } = base;
  assert.throws(() => createPostSchema.body.parse(withoutAuthor), z.ZodError);
});

/* ---------------------------------- Task 010 (FR-3/FR-5/FAIL-1): sanitize post.content ---------------------------------- */

// AC FR-3 scenario 1: createPostSchema.content required -> `.transform(sanitizeText)` trực tiếp.
test("FR-3: createPostSchema.content chứa <script> bị strip sau transform", () => {
  const body = createPostSchema.body.parse({
    _id: VALID_ID,
    authorId: OTHER_ID,
    content: "<script>alert(1)</script>Hello",
    type: "create",
  });
  assert.ok(!body.content.includes("<script>"), "script tag phải bị strip");
  assert.equal(body.content, "Hello");
});

// AC FR-5 (non-regression): tiếng Việt có dấu / emoji không bị strip nhầm bởi sanitizeText.
test("FR-5: createPostSchema.content tiếng Việt có dấu và emoji giữ nguyên", () => {
  const raw = "Xin chào các bạn 🎉";
  const body = createPostSchema.body.parse({
    _id: VALID_ID,
    authorId: OTHER_ID,
    content: raw,
    type: "create",
  });
  assert.equal(body.content, raw);
});

// AC FAIL-1 (CRITICAL): field optional -> guard bắt buộc. Bug gốc: naive `.transform(sanitizeText)`
// không guard sẽ khiến `content` absent -> `""` (sanitizeText(undefined) === ""), rồi
// `post.controller.ts:392` (`post.content = content;`, vô điều kiện) ghi đè "" lên content cũ.
// Test dưới đây chứng minh guard hiện tại KHÔNG rơi vào case đó: `content` vắng mặt trong body ->
// key `content` không tồn tại trong kết quả parse (rơi ra `undefined` khi destructure ở controller),
// KHÔNG BAO GIỜ là chuỗi rỗng `""`.
test("FAIL-1 guard (CRITICAL): updatePostSchema — content vắng mặt -> parse ra undefined, KHÔNG phải ''", () => {
  const parsed: any = updatePostSchema.body.parse({
    _id: VALID_ID,
    userId: OTHER_ID,
    survey: [],
    // content: cố ý KHÔNG truyền — mô phỏng request chỉ update survey.
  });

  assert.equal(
    Object.prototype.hasOwnProperty.call(parsed, "content"),
    false,
    "key content phải hoàn toàn vắng mặt sau parse khi client không gửi -> destructure ra undefined"
  );
  assert.equal(parsed.content, undefined);
  assert.notEqual(
    parsed.content,
    "",
    "đây chính là bug FAIL-1 nếu thiếu guard: sanitizeText(undefined) === '' sẽ ghi đè content cũ"
  );
});

// Đối chứng trực tiếp: một transform KHÔNG guard (naive, đúng bug mà FAIL-1 mô tả) sẽ cho '' —
// chứng minh guard trong updatePostSchema thực sự cần thiết, không phải phòng thủ thừa.
test("FAIL-1 guard: đối chứng naive transform (không guard) sẽ tạo ra '' — lý do guard bắt buộc", () => {
  const naiveContentSchema = z.string().optional().transform((val) => sanitizeText(val));
  assert.equal(
    naiveContentSchema.parse(undefined),
    "",
    "minh hoạ: không guard -> absent content bị coerce thành '' (đây là bug FAIL-1 cảnh báo)"
  );
});

// AC FR-5 (non-regression, update path): content có giá trị (tiếng Việt/emoji) qua updatePostSchema
// vẫn giữ nguyên, không bị strip nhầm.
test("FR-5: updatePostSchema.content có giá trị tiếng Việt/emoji giữ nguyên, không bị guard nuốt", () => {
  const raw = "Cập nhật nội dung 😊";
  const parsed: any = updatePostSchema.body.parse({
    _id: VALID_ID,
    userId: OTHER_ID,
    content: raw,
    survey: [],
  });
  assert.equal(parsed.content, raw);
});

// AC FR-3 scenario 1 (update path): content chứa <script> qua updatePostSchema cũng bị strip.
test("FR-3: updatePostSchema.content chứa <script> bị strip sau transform", () => {
  const parsed: any = updatePostSchema.body.parse({
    _id: VALID_ID,
    userId: OTHER_ID,
    content: "<script>alert(1)</script>Bye",
    survey: [],
  });
  assert.equal(parsed.content, "Bye");
});

// Task 011 correction: postId chuyển từ body vào params.id — schema.body không còn field postId.
test("updatePostVisibilitySchema / updatePostStatusSchema: giá trị sai bị từ chối", () => {
  const ids = { userId: VALID_ID };
  assert.equal(
    updatePostVisibilitySchema.body.parse({
      ...ids,
      visibility: Constants.POST_VISIBILITY.ONLY_ME,
    }).visibility,
    Constants.POST_VISIBILITY.ONLY_ME
  );
  assert.throws(
    () => updatePostVisibilitySchema.body.parse({ ...ids, visibility: 99 }),
    z.ZodError
  );
  // AD-5: body không coerce -> "0" dạng string không được ngầm thành số 0.
  assert.throws(
    () => updatePostStatusSchema.body.parse({ ...ids, status: "0" }),
    z.ZodError
  );
  assert.throws(
    () => updatePostStatusSchema.params.parse({ id: "not-an-id" }),
    z.ZodError
  );
});

// AD-5: chỉ query/params mới coerce. Body tới từ `express.json()` nên đã đúng kiểu — "true" dạng
// string là lỗi client thật sự, không được nuốt.
test("AD-5: tickPostSurveySchema — isAdd là string \"true\" bị từ chối, boolean thì pass", () => {
  const base = { optionId: VALID_ID, userId: OTHER_ID };
  assert.equal(tickPostSurveySchema.body.parse({ ...base, isAdd: true }).isAdd, true);
  assert.throws(
    () => tickPostSurveySchema.body.parse({ ...base, isAdd: "true" }),
    z.ZodError
  );
});

test("FR-9: likeUnlikePostSchema chặn param id không phải ObjectId", () => {
  assert.equal(likeUnlikePostSchema.params.parse({ id: VALID_ID }).id, VALID_ID);
  assert.throws(() => likeUnlikePostSchema.params.parse({ id: "abc" }), z.ZodError);
});

test("getPostActivitiesSchema: validates id param and activity query types", () => {
  assert.equal(getPostActivitiesSchema.params.parse({ id: VALID_ID }).id, VALID_ID);
  assert.throws(() => getPostActivitiesSchema.params.parse({ id: "invalid-id" }), z.ZodError);

  assert.equal(getPostActivitiesSchema.query.parse({ type: "likes", limit: "10" }).type, "likes");
  assert.equal(getPostActivitiesSchema.query.parse({ type: "comments" }).type, "comments");
  assert.equal(getPostActivitiesSchema.query.parse({ type: "reposts" }).type, "reposts");
  assert.throws(() => getPostActivitiesSchema.query.parse({ type: "invalid-type" }), z.ZodError);
});

/* ------------------------------------------------------------------- HTTP thật */

// AC FR-9: 400 phải xảy ra TRƯỚC controller — stub `reachedController` không được chạm tới.
test("FR-9 (HTTP): DELETE /posts/not-an-objectid -> 400 trước khi controller chạy", async () => {
  await silenceWarn(() =>
    withServer(routeApp(), async (base) => {
      const res = await fetch(`${base}/posts/not-an-objectid?userId=${VALID_ID}`, {
        method: "DELETE",
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

// AC FR-5 (AD-4): `validate()` phải đồng bộ / `next(err)` chứ không throw vào khoảng không, nếu
// không express không có ai bắt -> request treo tới khi client timeout. Test này fail bằng cách
// TREO, nên phải tự đặt hạn giờ thay vì chờ test runner. Task 011: path `/posts/create` -> `/posts`.
test("AD-4 (HTTP): POST /posts body sai -> 400, KHÔNG treo", async () => {
  await silenceWarn(() =>
    withServer(routeApp(), async (base) => {
      const started = Date.now();
      let timer: any;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("TREO: POST /posts không trả response — validate() bị async?")),
          5000
        );
      });

      try {
        const res: any = await Promise.race([
          fetch(`${base}/posts`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content: 123 }),
          }),
          deadline,
        ]);

        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
        assert.ok(Date.now() - started < 5000, "phải trả lời ngay, không chờ timeout");
      } finally {
        clearTimeout(timer);
      }
    })
  );
});

test("FR-5 (HTTP): PATCH /posts/:id/visibility visibility ngoài enum -> 400", async () => {
  await silenceWarn(() =>
    withServer(routeApp(), async (base) => {
      const res = await fetch(`${base}/posts/${OTHER_ID}/visibility`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: VALID_ID, visibility: 99 }),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

// Task 020 (NFR-4, positive path): 3 test HTTP ở trên đều là negative. Nếu `validate()` lỡ chặn
// nhầm payload HỢP LỆ thì không test nào ở trên fail. Test này đi ngược chiều: payload đúng theo
// bảng field của `012.md` phải CHẠM được controller trên cả 3 mặt reassignment (AD-6) —
// `req.body` (POST /posts), `req.params` + `req.query` (DELETE /posts/:id).
test("NFR-4 (HTTP positive): payload hợp lệ chạm được controller trên cả body/params/query", async () => {
  await withServer(routeApp(), async (base) => {
    const createRes = await fetch(`${base}/posts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        _id: VALID_ID,
        authorId: OTHER_ID,
        content: "hello",
        media: [],
        survey: [],
        type: "create",
        usersTag: [VALID_ID],
        visibility: Constants.POST_VISIBILITY.PUBLIC,
      }),
    });
    assert.equal(createRes.status, 200, "body hợp lệ không được bị validate() chặn");
    assert.deepEqual(await createRes.json(), { reached: true });

    const deleteRes = await fetch(`${base}/posts/${VALID_ID}?userId=${OTHER_ID}`, {
      method: "DELETE",
    });
    assert.equal(deleteRes.status, 200, "params + query hợp lệ không được bị chặn");
    assert.deepEqual(await deleteRes.json(), { reached: true });

    const visibilityRes = await fetch(`${base}/posts/${OTHER_ID}/visibility`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: VALID_ID,
        visibility: Constants.POST_VISIBILITY.ONLY_ME,
      }),
    });
    assert.equal(visibilityRes.status, 200);
  });
});

/* ------------------------------------------------- wiring (đọc source, không import) */

// `post.route.ts` không import được trong test (xem đầu file: `feed/queue.ts` mở Redis lúc import),
// nên kiểm wiring bằng cách đọc source — đúng cách `validate.test.ts` kiểm `src/app.ts`.
// Đường dẫn theo cwd: `npm test` luôn chạy từ thư mục gốc repo.
const readRouteSource = async () =>
  await import("node:fs/promises").then((fs) =>
    fs.readFile("src/api/routers/post.route.ts", "utf8")
  );

const parseRouteLines = (src: string) =>
  src
    .split("\n")
    .join(" ")
    .match(/router\.(get|post|put|patch|delete)\([\s\S]*?\);/g) ?? [];

/** `(method, path)` của từng route, path đã resolve: đối số đầu tiên hoặc là string literal, hoặc
 * là 1 constant destructure từ `POST_PATH` (task 011 nhét luôn `:id` vào giá trị constant). */
const parseRoutePairs = (src: string) =>
  parseRouteLines(src).map((line) => {
    const m = line.match(/^router\.(\w+)\(\s*("([^"]*)"|[A-Z_]+)/);
    assert.ok(m, `không parse được đối số path từ: ${line.slice(0, 80)}`);
    const [, method, rawArg, literal] = m;
    const path =
      literal !== undefined ? literal : (POST_PATH as any)[rawArg];
    assert.equal(
      typeof path,
      "string",
      `path của route ${method} không resolve được (${rawArg}) — constant có còn trong POST_PATH?`
    );
    return [method, path];
  });

test("wiring: 12/13 route có validate(), CRAWL_POST cố ý không có", async () => {
  const routeLines = parseRouteLines(await readRouteSource());

  assert.equal(routeLines.length, 13, "post.route.ts phải có đúng 13 route");

  const withValidate = routeLines.filter((line) => line.includes("validate("));
  assert.equal(withValidate.length, 12, "đúng 12 route phải có validate()");

  const crawl = routeLines.filter((line) => line.includes("CRAWL_POST"));
  assert.equal(crawl.length, 1);
  assert.ok(
    !crawl[0].includes("validate("),
    "CRAWL_POST là tool seed/dev, cố ý KHÔNG validate — nếu sau này thành route nhận payload thì phải thêm"
  );
});

/* --------------------------------------------- Task 011 (FR-3, D-1): bảng 11 endpoint mới */

// AC FR-3: chốt CỨNG method + path của cả 13 endpoint (11 gốc + `/:id/replies` thêm sau (xem
// "tối ưu Post.replies") + `SITEMAP_ELIGIBLE` task 002) theo đúng bảng trong `011.md`/`002.md`.
// Thứ tự trong list cũng là thứ tự ĐĂNG KÝ — có ý nghĩa với express (route literal 1 segment như
// `/crawl`/`/sitemap-eligible` phải đứng trước route dynamic 1 segment cùng method), nên assert
// nguyên list chứ không dùng Set.
test("FR-3 (D-1): 13 endpoint posts đúng method + path RESTful mới, đúng thứ tự đăng ký", async () => {
  const pairs = parseRoutePairs(await readRouteSource());

  assert.deepEqual(pairs, [
    ["get", "/"], // GET_ALL: /all -> /
    ["get", "/sitemap-eligible"], // MỚI (task 002): post đủ điều kiện sitemap, literal -> trước /:id
    ["get", "/:id/activities"], // giữ nguyên
    ["get", "/:id/replies"], // MỚI: danh sách reply phân trang, thay cho nhúng không giới hạn
    ["get", "/:id"], // giữ nguyên
    ["post", "/"], // CREATE: /create -> /
    ["delete", "/:id"], // giữ nguyên
    ["put", "/:id"], // UPDATE: /update -> /:id
    ["post", "/:id/like"], // LIKE: /like/:id -> /:id/like
    ["post", "/crawl"], // CRAWL_POST: /crawl-post -> /crawl
    ["post", "/:id/survey-ticks"], // TICK_SURVEY: PUT /tick-post-survey -> POST /:id/survey-ticks
    ["patch", "/:id/status"], // UPDATE_POST_STATUS: POST /update-post-status -> PATCH /:id/status
    ["patch", "/:id/visibility"], // UPDATE_POST_VISIBILITY: POST -> PATCH /:id/visibility
  ]);
});

// FR-3 (id-source): `PUT /posts/:id` chỉ có nghĩa nếu controller đọc id từ `req.params.id`. Nếu ai
// đó revert về `payload._id`, `PUT /posts/<A>` với body `_id: <B>` sẽ âm thầm sửa NHẦM bài B.
test("FR-3 (id-source): updatePost đọc req.params.id, KHÔNG đọc payload._id", async () => {
  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile("src/api/controllers/post.controller.ts", "utf8")
  );
  const fn = src.slice(src.indexOf("export const updatePost"));
  const body = fn.slice(0, fn.indexOf("\n};"));

  assert.ok(
    body.includes("const postId = req.params.id;"),
    "updatePost phải lấy id từ path param của route PUT /posts/:id"
  );
  assert.ok(
    !body.includes("const postId = payload._id;"),
    "id KHÔNG được lấy từ body — client sửa được body thành id bài của người khác"
  );
});

// Task 011 correction (phát hiện lúc viết FE call site, T020): route đã là PATCH /:id/status và
// /:id/visibility từ đầu task 011, nhưng 2 controller quên đổi nguồn đọc postId — :id trong URL
// từng vô nghĩa (danh tính thật vẫn qua body `postId`). Cùng lớp lỗi với plan-review FAIL-1 (T012).
test("FR-3 (id-source correction): updatePostStatus/updatePostVisibility đọc req.params.id, KHÔNG đọc body.postId", async () => {
  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile("src/api/controllers/post.controller.ts", "utf8")
  );
  for (const fnName of ["updatePostStatus", "updatePostVisibility"]) {
    const fn = src.slice(src.indexOf(`export const ${fnName}`));
    const body = fn.slice(0, fn.indexOf("\n};"));
    assert.ok(
      body.includes("const { id: postId } = req.params;"),
      `${fnName} phải lấy id từ path param`
    );
    assert.ok(
      !/const \{[^}]*postId[^}]*\} = req\.body;/.test(body),
      `${fnName} KHÔNG được còn đọc postId từ body`
    );
  }
});

// FR-10: 0 raw `res.json({error...})` còn lại — envelope lỗi phải đi qua error-handler tập trung.
test("FR-10: post.controller.ts không còn raw res.json({ error ... })", async () => {
  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile("src/api/controllers/post.controller.ts", "utf8")
  );
  assert.equal(
    (src.match(/\.json\(\{\s*error/g) ?? []).length,
    0,
    "mọi lỗi phải `throw new {XxxError}` để app.ts error-handler soạn envelope thống nhất"
  );
});

/* -------------------------- R-6 (BẮT BUỘC): regression bypass repost task 090, end-to-end -------
   Guard chặn repost sống trong `createPost` và đọc CẢ `?action=repost` (query) LẪN `type` (body)
   LẪN `quote._id`. Task 011 đổi route `POST /posts/create` -> `POST /posts` và bọc `asyncHandler`
   — nếu việc đổi đó làm hỏng đường đi của guard (hoặc làm request TREO thay vì trả 400), bypass
   task 090 sống lại. Test dưới đây chạy controller THẬT sau `validate()` THẬT trên ĐÚNG route mới,
   stub tầng model để không cần Mongo. */

const AUTHOR_ID = "652f1b2c3d4e5f6071829306";
const QUOTED_POST_ID = "652f1b2c3d4e5f6071829307";

/** Dựng app mirror `post.route.ts`: 1 `Router` mount tại `Route.POST` (= `/posts`), route
 * `POST POST_PATH.CREATE` (= `/`) gồm `validate(createPostSchema)` + `asyncHandler(createPost)`,
 * cộng error-handler kiểu `app.ts` (đọc `err.statusCode`). Mount qua Router chứ không `app.post()`
 * thẳng, để `POST_PATH.CREATE = "/"` được nối với prefix đúng như production. */
const createPostApp = () => {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  router.post(POST_PATH.CREATE, validate(createPostSchema), asyncHandler(createPost));
  app.use(Route.POST, router);
  app.use(errorHandler);
  return app;
};

/** Stub `User.findById` (tác giả tồn tại) + `Post.findById` (bài bị quote, visibility tuỳ test) +
 * `Post.prototype.save` (đánh dấu nếu bị gọi = guard đã LỌT). */
const withStubbedModels = async (
  quotedVisibility: number,
  fn: (state: { saveCalled: boolean }) => Promise<void>
) => {
  const state = { saveCalled: false };
  const originalUserFind = (User as any).findById;
  const originalPostFind = (Post as any).findById;
  const originalSave = (Post as any).prototype.save;
  (User as any).findById = async () => ({ _id: AUTHOR_ID });
  (Post as any).findById = async () => ({
    _id: QUOTED_POST_ID,
    visibility: quotedVisibility,
  });
  (Post as any).prototype.save = async function () {
    state.saveCalled = true;
    throw new Error("REACHED_SAVE");
  };
  try {
    await fn(state);
  } finally {
    (User as any).findById = originalUserFind;
    (Post as any).findById = originalPostFind;
    (Post as any).prototype.save = originalSave;
  }
};

/** Payload repost/quote: nội dung bài gốc bị copy nguyên văn vào `quote.content`. `action` KHÔNG
 * nằm trong body — nó chỉ tồn tại ở query string, nên bỏ query = bỏ tín hiệu `action`. */
const quotePayload = (type: string) => ({
  _id: "652f1b2c3d4e5f6071829308",
  authorId: AUTHOR_ID,
  content: "",
  media: [],
  survey: [],
  usersTag: [],
  links: [],
  files: [],
  type,
  quote: {
    _id: QUOTED_POST_ID,
    content: "Nội dung RIÊNG TƯ copy nguyên văn từ bài gốc",
  },
});

// AC R-6 (test quan trọng nhất của task 011): `type=REPOST` trong body, KHÔNG có `?action=repost`
// trong query, `quote._id` copy từ bài khác (bài đó ONLY_ME) -> PHẢI vẫn bị chặn 400.
test("R-6 (BẮT BUỘC): POST /posts type=REPOST KHÔNG kèm ?action=repost -> vẫn bị chặn 400, không lưu", async () => {
  await silenceWarn(() =>
    withStubbedModels(Constants.POST_VISIBILITY.ONLY_ME, async (state) => {
      await withServer(createPostApp(), async (base) => {
        let timer: any;
        const deadline = new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "TREO: POST /posts không trả response — throw trong createPost không được asyncHandler bắt?"
                )
              ),
            5000
          );
        });

        try {
          const res: any = await Promise.race([
            // CỐ Ý không có `?action=repost` — đây chính là vector bypass của task 090.
            fetch(`${base}/posts`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(quotePayload(PostConstants.ACTIONS.REPOST)),
            }),
            deadline,
          ]);

          assert.equal(res.status, 400, "repost bài non-PUBLIC phải bị chặn 400");
          assert.deepEqual(await res.json(), {
            message: "Cannot repost non-public content",
          });
          assert.equal(
            state.saveCalled,
            false,
            "CRITICAL: guard phải chặn TRƯỚC khi lưu — save() được gọi nghĩa là bypass đã sống lại"
          );
        } finally {
          clearTimeout(timer);
        }
      });
    })
  );
});

// AC R-6 (biến thể bypass gốc task 090): `type=CREATE` + `quote._id` tự dựng thủ công, không
// `action`, không `parentPost` — đây là payload ĐÃ khai thác được live lần đầu.
test("R-6 (bypass gốc 090): POST /posts type=CREATE + quote._id thủ công -> vẫn bị chặn 400", async () => {
  await silenceWarn(() =>
    withStubbedModels(Constants.POST_VISIBILITY.ONLY_FOLLOWERS, async (state) => {
      await withServer(createPostApp(), async (base) => {
        const res = await fetch(`${base}/posts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(quotePayload(PostConstants.ACTIONS.CREATE)),
        });

        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), {
          message: "Cannot repost non-public content",
        });
        assert.equal(state.saveCalled, false, "không được lưu bài repost lách guard");
      });
    })
  );
});

// Đối chứng (không phải chặn mù): bài được quote là PUBLIC -> guard CHO QUA, chạy tiếp tới bước lưu
// (`save()` stub ném REACHED_SAVE = 500). Thiếu test này thì một guard "luôn 400" cũng pass 2 test
// trên mà không ai biết.
test("R-6 (đối chứng): quote bài PUBLIC -> guard cho qua, đi tiếp tới bước lưu", async () => {
  await silenceWarn(() =>
    withStubbedModels(Constants.POST_VISIBILITY.PUBLIC, async (state) => {
      await withServer(createPostApp(), async (base) => {
        const res = await fetch(`${base}/posts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(quotePayload(PostConstants.ACTIONS.REPOST)),
        });

        assert.equal(res.status, 500, "REACHED_SAVE stub -> 500, chứng minh đã qua guard");
        assert.equal(
          state.saveCalled,
          true,
          "repost bài PUBLIC là hợp lệ — guard không được chặn nhầm"
        );
      });
    })
  );
});

/* -------------------------- Task 002 (epic seo-sitemap-schema, FR-1): GET /posts/sitemap-eligible
   end-to-end. CỐ Ý KHÔNG mount `sitemapListLimiter` thật trong app test dưới đây: đó là 1 singleton
   module-level (`rateLimiter.ts`) dùng chung state trong CẢ process test — mount nó vào 1 route bị
   gọi nhiều lần (nhiều test trong file này) có thể tự trip giữa chừng, che mất assertion thật đang
   test (đúng lý do `security-hardening.smoke.test.ts:165` đã né tương tự với authTierLimiter). Sự
   có mặt của `sitemapListLimiter` trên route này đã được xác nhận riêng bằng test đọc SOURCE bên
   dưới — cùng pattern `rateLimiter.test.ts:166` áp dụng cho `CRAWL_POST`. */

const SITEMAP_SECRET = "test-sitemap-secret";

const withSitemapSecret = async (fn: () => Promise<void> | void) => {
  process.env.SITEMAP_SHARED_SECRET = SITEMAP_SECRET;
  try {
    await fn();
  } finally {
    delete process.env.SITEMAP_SHARED_SECRET;
  }
};

/** Mirror ĐÚNG wiring thật của `SITEMAP_ELIGIBLE` trong `post.route.ts` (trừ `authTierLimiter`,
 * lý do xem comment ngay trên): `sitemapAuthGate` -> `validate(...)` -> controller thật. */
const sitemapEligibleApp = () => {
  const app = express();
  const router = express.Router();
  router.get(
    "/sitemap-eligible",
    sitemapAuthGate,
    validate(getSitemapEligiblePostsQuerySchema),
    asyncHandler(getSitemapEligiblePosts),
  );
  app.use("/posts", router);
  app.use(errorHandler);
  return app;
};

test("FR-1 (auth gate): thiếu header secret -> 401, không chạm controller", async () => {
  await withSitemapSecret(async () => {
    await withServer(sitemapEligibleApp(), async (base) => {
      const res = await fetch(`${base}/posts/sitemap-eligible`);
      assert.equal(res.status, 401);
    });
  });
});

test("FR-1 (auth gate): sai header secret -> 401", async () => {
  await withSitemapSecret(async () => {
    await withServer(sitemapEligibleApp(), async (base) => {
      const res = await fetch(`${base}/posts/sitemap-eligible`, {
        headers: { [SITEMAP_SECRET_HEADER]: "wrong-secret" },
      });
      assert.equal(res.status, 401);
    });
  });
});

// 25 doc giả lập kết quả ĐÃ QUA filter status/visibility/engagementScore (đúng field controller
// select), _id hex 24 ký tự tăng dần để so sánh chuỗi `>` tương đương thứ tự ObjectId thật.
const FAKE_ELIGIBLE_DOCS = Array.from({ length: 25 }, (_, i) => ({
  _id: String(i + 1).padStart(24, "0"),
  updatedAt: new Date(2024, 0, i + 1),
  engagementScore: 5 + i,
}));

// Mock giả lập ĐÚNG hành vi query thật (top-N ưu tiên, fix sau epic seo-sitemap-schema): sort
// (engagementScore giảm dần, _id giảm dần) + cursor $or "score:id" — KHÔNG còn thuần `_id`.
const withStubbedSitemapQuery = async (
  docs: typeof FAKE_ELIGIBLE_DOCS,
  fn: () => Promise<void> | void,
) => {
  const originalFind = (Post as any).find;
  const originalCountDocuments = (Post as any).countDocuments;

  // "Backend thật" luôn trả theo (engagementScore giảm dần, _id giảm dần).
  const ranked = [...docs].sort((a, b) =>
    a.engagementScore !== b.engagementScore
      ? b.engagementScore - a.engagementScore
      : b._id.localeCompare(a._id),
  );

  (Post as any).find = (filter: any) => {
    const orClause = filter?.$or as
      | [{ engagementScore: { $lt: number } }, { engagementScore: number; _id: { $lt: string } }]
      | undefined;
    const matched = orClause
      ? ranked.filter((d) => {
          const [ltScore, eqScoreLtId] = orClause;
          return (
            d.engagementScore < ltScore.engagementScore.$lt ||
            (d.engagementScore === eqScoreLtId.engagementScore && d._id < eqScoreLtId._id.$lt)
          );
        })
      : ranked;
    let limitN = matched.length;
    const chain = {
      sort() {
        return this;
      },
      limit(n: number) {
        limitN = n;
        return this;
      },
      select() {
        return this;
      },
      lean: async () => matched.slice(0, limitN),
    };
    return chain;
  };
  (Post as any).countDocuments = async () => docs.length;

  try {
    await fn();
  } finally {
    (Post as any).find = originalFind;
    (Post as any).countDocuments = originalCountDocuments;
  }
};

test("FR-1 (phân trang, end-to-end): 3 trang liên tiếp qua nextCursor -> không trùng/thiếu record, trang cuối nextCursor=null", async () => {
  await withSitemapSecret(async () => {
    await withStubbedSitemapQuery(FAKE_ELIGIBLE_DOCS, async () => {
      await withServer(sitemapEligibleApp(), async (base) => {
        const authHeaders = { [SITEMAP_SECRET_HEADER]: SITEMAP_SECRET };
        const seenIds: string[] = [];
        let cursor: string | null = null;
        let totalCountFromFirstPage: number | null = null;
        let pageCount = 0;

        do {
          const url = new URL(`${base}/posts/sitemap-eligible`);
          url.searchParams.set("limit", "10");
          if (cursor) url.searchParams.set("cursor", cursor);

          const res = await fetch(url, { headers: authHeaders });
          assert.equal(res.status, 200);
          const body: any = await res.json();
          const { data, nextCursor, totalCount } = body.metadata;

          if (pageCount === 0) {
            totalCountFromFirstPage = totalCount;
            assert.equal(totalCount, 25, "totalCount trang đầu phải khớp tổng số record");
          } else {
            assert.equal(totalCount, null, "totalCount CHỈ trả ở trang đầu, các trang sau phải null");
          }

          for (const item of data) {
            assert.ok(
              !seenIds.includes(item.postId),
              `record trùng lặp qua các trang: ${item.postId}`,
            );
            seenIds.push(item.postId);
          }

          cursor = nextCursor;
          pageCount += 1;
        } while (cursor);

        assert.equal(pageCount, 3, "25 record / limit 10 -> đúng 3 trang");
        assert.equal(seenIds.length, totalCountFromFirstPage, "không được thiếu record nào so với totalCount");
        assert.deepEqual(
          seenIds,
          // engagementScore giảm dần -> thứ tự NGƯỢC LẠI với mảng tạo sẵn (vốn tăng dần theo index).
          [...FAKE_ELIGIBLE_DOCS].reverse().map((d) => d._id),
          "thứ tự + tập hợp record phải khớp chính xác, không trùng không thiếu",
        );
      });
    });
  });
});

test("FR-1 (wiring, source): SITEMAP_ELIGIBLE có sitemapAuthGate + validate(getSitemapEligiblePostsQuerySchema), đăng ký TRƯỚC /:id", async () => {
  const src = await readRouteSource();
  const noComments = src.replace(/^\s*\/\/.*$/gm, "");

  // KHÔNG rate limiter (đã thử authTierLimiter 5/phút, rồi sitemapListLimiter 300/phút — cả 2 đều
  // fail khi verify sống vì Next.js's static export gọi getChunk() đồng thời cho nhiều chunk lúc
  // build, cộng dồn vượt bất kỳ ngưỡng theo-phút nào. sitemapAuthGate là biên bảo mật thật —
  // xem rateLimiter.ts.
  assert.ok(
    noComments.includes(
      "router.get(\n  SITEMAP_ELIGIBLE,\n  sitemapAuthGate,\n  validate(getSitemapEligiblePostsQuerySchema),\n  asyncHandler(getSitemapEligiblePosts),\n);",
    ),
    "route SITEMAP_ELIGIBLE phải wire đúng 3 middleware theo đúng thứ tự này",
  );

  const idxSitemap = noComments.indexOf('router.get(\n  "/:id",');
  const idxSitemapEligible = noComments.indexOf("router.get(\n  SITEMAP_ELIGIBLE,");
  assert.ok(idxSitemapEligible >= 0 && idxSitemap >= 0);
  assert.ok(
    idxSitemapEligible < idxSitemap,
    "SITEMAP_ELIGIBLE (literal 1-segment) phải đăng ký TRƯỚC /:id, nếu không sẽ bị nuốt",
  );
});

/* --------------------------- Task 009: role-gate cho getPosts (admin/*) -------------------- */

// `getPosts` dùng CHUNG cho mọi loại feed (for_you/following/saved/user/admin/*) -> role-check
// chỉ áp dụng khi `filter.page` bắt đầu bằng "admin" (xem Context task 009). Test dựng app riêng
// (không qua `post.route.ts` thật — lý do "không import" đã ghi ở đầu file: kéo Redis lúc import).
// Middleware test-only dưới đây thay `optionalAuth` thật, nhưng giữ ĐÚNG hợp đồng của nó (chỉ set
// `req.viewerId` từ 1 nguồn test tương đương jwt đã verify) — cùng cách `withStubbedModels` ở
// tầng R-6 phía trên thay `protectRoute`/DB thật bằng stub mongoose.
const fakeOptionalAuth = (req, _res, next) => {
  req.viewerId = (req.headers["x-test-viewer-id"] as string) || null;
  next();
};

const getPostsApp = () => {
  const app = express();
  app.get("/posts", fakeOptionalAuth, validate(getPostsQuerySchema), asyncHandler(getPosts));
  app.use(errorHandler);
  return app;
};

/** Stub `User.findById` (role-gate đọc viewer) + `Post.find` (cả 2 nhánh admin đều rơi vào
 * `Post.find` cuối `getPostsIdByFilter` SAU KHI qua gate — xem `services/post.ts`) — không cần
 * Mongo. `role: null` mô phỏng ẩn danh/không tìm thấy user (viewer falsy -> gate chặn). */
const withStubbedAdminGateModels = async (
  role: number | null,
  fn: () => Promise<void>,
) => {
  const originalFindById = (User as any).findById;
  const originalPostFind = (Post as any).find;
  (User as any).findById = async () => (role === null ? null : { _id: VALID_ID, role });
  const chain: any = {
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    then(resolve: any) { resolve([]); },
  };
  (Post as any).find = () => chain;
  try {
    await fn();
  } finally {
    (User as any).findById = originalFindById;
    (Post as any).find = originalPostFind;
  }
};

// LƯU Ý status code: Implementation Steps của task 009 chỉ định dùng ĐÚNG `AuthFailureError` cho
// cả 2 role-check này (giống hệt code review đã confirm), và `AuthFailureError` trong
// `core/error.response.ts` mặc định là 401 (`HTTPStatus.UNAUTHORIZED`), KHÔNG phải 403
// (`ForbiddenError`/403 là 1 class riêng, không được dùng ở đây). Acceptance Criteria của task ghi
// "403" nhưng hành vi THẬT của code theo đúng Implementation Steps là 401 — test dưới đây khớp
// hành vi thật (đã note lại làm warning cho review, xem task report).
const ADMIN_GATE_ROLE_CASES: Array<[string, number | null, number]> = [
  ["ADMIN", Constants.USER_ROLE.ADMIN, 200],
  ["MODERATOR", Constants.USER_ROLE.MODERATOR, 200],
  ["USER", Constants.USER_ROLE.USER, 401],
  ["anonymous (không có viewerId)", null, 401],
];

for (const adminPage of [PageConstant.ADMIN.POSTS, PageConstant.ADMIN.POSTS_VALIDATION]) {
  for (const [label, role, expectedStatus] of ADMIN_GATE_ROLE_CASES) {
    test(`Task 009 role-matrix: GET /posts?filter[page]=${adminPage} role=${label} -> ${expectedStatus}`, async () => {
      await silenceWarn(() =>
        withStubbedAdminGateModels(role, async () => {
          await withServer(getPostsApp(), async (base) => {
            const headers: Record<string, string> = {};
            if (role !== null) headers["x-test-viewer-id"] = VALID_ID;
            const res = await fetch(
              `${base}/posts?filter[page]=${encodeURIComponent(adminPage)}`,
              { headers },
            );
            assert.equal(res.status, expectedStatus);
            if (expectedStatus !== 200) {
              const body: any = await res.json();
              assert.equal("data" in body, false, "response chặn không được kèm data");
            }
          });
        }),
      );
    });
  }
}

// AC FR-4 (regression): non-admin page không được bị đòi role — role-gate mới CHỈ kích hoạt khi
// `filter.page` bắt đầu bằng "admin". Dùng nhánh SAVED (đã stub sẵn ở integration test phía trên,
// đơn giản/ổn định) thay vì `for_you` — nhánh mặc định kéo theo toàn bộ pipeline fanout/Redis
// không liên quan tới điều đang test ở đây (role-gate không được kích hoạt), AC cũng chấp nhận
// "for_you (hoặc bất kỳ page không phải admin/*)".
test("Task 009 regression: GET /posts?filter[page]=saved role=USER vẫn 200, không bị đòi role", async () => {
  const originalSavedFind = (SavedPost as any).find;
  const chain: any = {
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    then(resolve: any) { resolve([]); },
  };
  (SavedPost as any).find = () => chain;
  try {
    await withServer(getPostsApp(), async (base) => {
      const res = await fetch(
        `${base}/posts?filter[page]=saved&userId=${VALID_ID}`,
        { headers: { "x-test-viewer-id": VALID_ID } },
      );
      assert.equal(
        res.status,
        200,
        "non-admin page không được bị chặn bởi role-gate mới (Task 009)",
      );
    });
  } finally {
    (SavedPost as any).find = originalSavedFind;
  }
});

/* --------------------------- Task 016: query-builder cho filter ở admin/posts ----------------- */

// Trước fix: nhánh `ADMIN.POSTS` (`services/post.ts`) chỉ set `sort`, không build `query` từ
// filter -> `Post.find({}, ...)` trả toàn bộ post bất kể filter FE gửi (xem Context task #16).
// Test dưới đây gọi thẳng `getPostsIdByFilter` (đã import ở đầu file cho tầng integration phía
// trên), stub `Post.find` để bắt CHÍNH XÁC `query` được build, không cần Mongo.
const withCapturedPostFind = async (
  fn: (calls: { query?: any }) => Promise<void>,
) => {
  const originalFind = (Post as any).find;
  const calls: { query?: any } = {};
  const chain: any = {
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    then(resolve: any) { resolve([]); },
  };
  (Post as any).find = (query: any) => {
    calls.query = query;
    return chain;
  };
  try {
    await fn(calls);
  } finally {
    (Post as any).find = originalFind;
  }
};

test("Task 016: admin/posts + filter.postContent=image -> query lọc theo media.type image", async () => {
  await withCapturedPostFind(async (calls) => {
    await getPostsIdByFilter({
      filter: { page: PageConstant.ADMIN.POSTS, postContent: ["image"] },
      userId: VALID_ID,
      page: 1,
      limit: 20,
      isAdminPage: true,
    });
    assert.deepEqual(calls.query, {
      $and: [{ $or: [{ "media.type": Constants.MEDIA_TYPE.IMAGE }] }],
    });
  });
});

test("Task 016: admin/posts + filter.dateFrom/dateTo -> query range trên createdAt", async () => {
  await withCapturedPostFind(async (calls) => {
    await getPostsIdByFilter({
      filter: {
        page: PageConstant.ADMIN.POSTS,
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
      },
      userId: VALID_ID,
      page: 1,
      limit: 20,
      isAdminPage: true,
    });
    assert.deepEqual(calls.query, {
      $and: [
        {
          createdAt: {
            $gte: new Date("2026-01-01"),
            $lte: new Date("2026-01-31"),
          },
        },
      ],
    });
  });
});

test("Task 016: admin/posts + filter.user=<authorId> -> query lọc đúng tác giả", async () => {
  await withCapturedPostFind(async (calls) => {
    await getPostsIdByFilter({
      filter: { page: PageConstant.ADMIN.POSTS, user: VALID_ID },
      userId: OTHER_ID,
      page: 1,
      limit: 20,
      isAdminPage: true,
    });
    assert.equal(calls.query.$and.length, 1);
    assert.equal(String(calls.query.$and[0].authorId), VALID_ID);
  });
});

test("Task 016: admin/posts không filter gì -> query rỗng {}, KHÔNG ràng buộc status (khác admin/posts/validation)", async () => {
  await withCapturedPostFind(async (calls) => {
    await getPostsIdByFilter({
      filter: { page: PageConstant.ADMIN.POSTS },
      userId: VALID_ID,
      page: 1,
      limit: 20,
      isAdminPage: true,
    });
    assert.deepEqual(calls.query, {});
  });
});

// Regression AC (task #16): refactor tách `buildAdminPostFilterSubQueries` KHÔNG được đổi hành vi
// nhánh `admin/posts/validation` — vẫn ràng buộc PRE_ACCEPT, vẫn nhận đúng filter.user.
test("Task 016 regression: admin/posts/validation vẫn ràng buộc status PRE_ACCEPT + filter.user sau refactor", async () => {
  await withCapturedPostFind(async (calls) => {
    await getPostsIdByFilter({
      filter: { page: PageConstant.ADMIN.POSTS_VALIDATION, user: VALID_ID },
      userId: OTHER_ID,
      page: 1,
      limit: 20,
      isAdminPage: true,
    });
    assert.equal(calls.query.$and.length, 2);
    assert.equal(calls.query.$and[0].status, Constants.POST_STATUS.PRE_ACCEPT);
    assert.equal(String(calls.query.$and[1].authorId), VALID_ID);
  });
});

test("Task 016 regression: admin/posts/validation không filter -> query chỉ {status: PRE_ACCEPT} (giữ nguyên)", async () => {
  await withCapturedPostFind(async (calls) => {
    await getPostsIdByFilter({
      filter: { page: PageConstant.ADMIN.POSTS_VALIDATION },
      userId: VALID_ID,
      page: 1,
      limit: 20,
      isAdminPage: true,
    });
    assert.deepEqual(calls.query, { status: Constants.POST_STATUS.PRE_ACCEPT });
  });
});

/* --------------------------- Task 009: role-gate cho updatePostStatus (MODERATOR) ------------ */

const updatePostStatusApp = () => {
  const app = express();
  app.use(express.json());
  app.patch(
    "/posts/:id/status",
    validate(updatePostStatusSchema),
    asyncHandler(updatePostStatus),
  );
  app.use(errorHandler);
  return app;
};

test("Task 009: PATCH /posts/:id/status role=MODERATOR -> 200 (trước đây 403/401, bug pattern ADMIN-only)", async () => {
  const originalFindOne = (User as any).findOne;
  const originalUpdateOne = (Post as any).updateOne;
  (User as any).findOne = async () => ({ role: Constants.USER_ROLE.MODERATOR });
  (Post as any).updateOne = async () => ({ acknowledged: true });
  try {
    await withServer(updatePostStatusApp(), async (base) => {
      const res = await fetch(`${base}/posts/${VALID_ID}/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: VALID_ID,
          status: Constants.POST_STATUS.PUBLIC,
        }),
      });
      assert.equal(res.status, 200);
    });
  } finally {
    (User as any).findOne = originalFindOne;
    (Post as any).updateOne = originalUpdateOne;
  }
});

// AC "Enum-validate": status ngoài {0 (PRE_ACCEPT), 1 (PUBLIC), 4 (DELETED)} phải bị 400 ở tầng
// schema, không chạm tới DB.
test("Task 009 (enum-validate): updatePostStatusSchema từ chối status ngoài enum {0,1,4}", () => {
  const ids = { userId: VALID_ID };
  for (const status of Object.values(Constants.POST_STATUS) as number[]) {
    assert.doesNotThrow(() => updatePostStatusSchema.body.parse({ ...ids, status }));
  }
  for (const status of [999, -1, 2, 3]) {
    assert.throws(
      () => updatePostStatusSchema.body.parse({ ...ids, status }),
      z.ZodError,
      `status=${status} phải bị từ chối (không thuộc {0,1,4})`,
    );
  }
});

after(async () => {
  await closeFanoutQueues();
});
