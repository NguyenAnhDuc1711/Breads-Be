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
import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import express from "express";
import { z } from "zod";
import PageConstant from "../../Breads-Shared/Constants/PageConstants.js";
import { Constants } from "../../Breads-Shared/Constants/index.js";
import logger from "../../core/logger.ts";
import { VALIDATION_ERROR_MESSAGE, validate } from "../middlewares/validate.ts";
import SavedPost from "../models/savedPost.model.ts";
import { getPostsIdByFilter } from "../services/post.ts";
import {
  createPostSchema,
  deletePostSchema,
  getPostsQuerySchema,
  likeUnlikePostSchema,
  tickPostSurveySchema,
  updatePostStatusSchema,
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
 * middleware và việc `/create` KHÔNG có `asyncHandler`. */
const routeApp = () => {
  const app = express();
  app.use(express.json());
  app.post("/posts/create", validate(createPostSchema), reachedController);
  app.delete("/posts/:id", validate(deletePostSchema), reachedController);
  app.post(
    "/posts/update-post-visibility",
    validate(updatePostVisibilitySchema),
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

test("updatePostVisibilitySchema / updatePostStatusSchema: giá trị sai bị từ chối", () => {
  const ids = { userId: VALID_ID, postId: OTHER_ID };
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
    () => updatePostStatusSchema.body.parse({ ...ids, postId: "not-an-id", status: 0 }),
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

// AC FR-5 (AD-4): `POST /create` là route DUY NHẤT không bọc `asyncHandler`. Nếu `validate()` lỡ
// thành async (hoặc throw thay vì `next(err)`), express không có ai bắt -> request treo tới khi
// client timeout. Test này fail bằng cách TREO, nên phải tự đặt hạn giờ thay vì chờ test runner.
test("AD-4 (HTTP): POST /posts/create body sai -> 400, KHÔNG treo", async () => {
  await silenceWarn(() =>
    withServer(routeApp(), async (base) => {
      const started = Date.now();
      let timer: any;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("TREO: /posts/create không trả response — validate() bị async?")),
          5000
        );
      });

      try {
        const res: any = await Promise.race([
          fetch(`${base}/posts/create`, {
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

test("FR-5 (HTTP): POST /posts/update-post-visibility visibility ngoài enum -> 400", async () => {
  await silenceWarn(() =>
    withServer(routeApp(), async (base) => {
      const res = await fetch(`${base}/posts/update-post-visibility`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: VALID_ID, postId: OTHER_ID, visibility: 99 }),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

// Task 020 (NFR-4, positive path): 3 test HTTP ở trên đều là negative. Nếu `validate()` lỡ chặn
// nhầm payload HỢP LỆ thì không test nào ở trên fail. Test này đi ngược chiều: payload đúng theo
// bảng field của `012.md` phải CHẠM được controller trên cả 3 mặt reassignment (AD-6) —
// `req.body` (/create), `req.params` + `req.query` (DELETE /posts/:id).
test("NFR-4 (HTTP positive): payload hợp lệ chạm được controller trên cả body/params/query", async () => {
  await withServer(routeApp(), async (base) => {
    const createRes = await fetch(`${base}/posts/create`, {
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

    const visibilityRes = await fetch(`${base}/posts/update-post-visibility`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: VALID_ID,
        postId: OTHER_ID,
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
test("wiring: 9/10 route có validate(), CRAWL_POST cố ý không có", async () => {
  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile("src/api/routers/post.route.ts", "utf8")
  );

  const routeLines = src
    .split("\n")
    .join(" ")
    .match(/router\.(get|post|put|delete)\([\s\S]*?\);/g);

  assert.ok(routeLines, "không parse được route nào từ post.route.ts");
  assert.equal(routeLines.length, 10, "post.route.ts phải có đúng 10 route");

  const withValidate = routeLines.filter((line) => line.includes("validate("));
  assert.equal(withValidate.length, 9, "đúng 9 route phải có validate()");

  const crawl = routeLines.filter((line) => line.includes("CRAWL_POST"));
  assert.equal(crawl.length, 1);
  assert.ok(
    !crawl[0].includes("validate("),
    "CRAWL_POST là tool seed/dev, cố ý KHÔNG validate — nếu sau này thành route nhận payload thì phải thêm"
  );
});
