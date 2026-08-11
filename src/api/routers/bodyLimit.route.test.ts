// Run with Node's built-in test runner: `npm test`.
//
// Phạm vi: Task 010 (security-hardening, FR-2) — bỏ `express.json` global ở `src/app.ts`, mount
// `express.json({limit})` per-router cho 7 router "thuần" (post/report/util/message/analytics/
// collection/notification).
//
// Vì sao không import router thật (AD-7, giống `post.route.test.ts`/`util.route.test.ts`): các file
// route kéo theo controller -> `services/feed/queue.ts` mở Redis + Cloudinary NGAY LÚC IMPORT, giữ
// event loop sống nên `npm test` sẽ treo. Vì vậy:
//  - Tầng HÀNH VI: dựng `express()` mới, mount ĐÚNG limit của từng router + `validate()` THẬT +
//    schema THẬT -> đo hành vi 413/200 thật qua HTTP.
//  - Tầng CHỐNG DRIFT: đọc SOURCE `src/app.ts` + 7 file router, assert global đã bị bỏ và từng
//    router mount đúng limit TRƯỚC route đầu tiên. Đây là phần bắt được landmine "parse-once":
//    nếu global 50mb quay lại `app.ts`, mọi limit per-router thành no-op mà test hành vi KHÔNG
//    phát hiện được (vì test hành vi không đi qua `app.ts`).
import assert from "node:assert/strict";
import { once } from "node:events";
import fsp from "node:fs/promises";
import { test } from "node:test";
import express from "express";
import logger from "../../core/logger.ts";
import { upload } from "../middlewares/upload.js";
import { validate } from "../middlewares/validate.ts";
import { createEventSchema } from "../validators/analytics.validator.ts";
import { searchMsgSchema } from "../validators/message.validator.ts";
import { createPostSchema } from "../validators/post.validator.ts";
import { sendForgotPWMailSchema } from "../validators/util.validator.ts";

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

/** Mirror cách `src/app.ts` map lỗi -> status: body-parser gắn `err.status = 413` cho
 * `entity.too.large`, nên request vượt limit trả về đúng 413. */
const errorHandler = (err, _req, res, _next) => {
  const statusCode = err.statusCode || err.status || 500;
  res.status(statusCode).json({ message: err.message, type: err.type });
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

/** Nếu request chạm được đây nghĩa là body-parser ĐÃ parse xong và `validate()` cho qua. */
const reachedController = (req, res) => {
  res.json({ reached: true, contentLength: JSON.stringify(req.body ?? {}).length });
};

const postJson = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/* ------------------------------------------------ post router: 50mb (regression base64) */

// AC FR-2: media base64 vài MB vẫn phải qua được sau khi bỏ global 50mb — router giữ 50mb.
test("FR-2 (post router 50mb): createPost với media base64 ~3MB vẫn 200, không bị 413", async () => {
  const app = express();
  app.use(express.json({ limit: "50mb" }));
  app.post("/posts/create", validate(createPostSchema), reachedController);
  app.use(errorHandler);

  await withServer(app, async (base) => {
    const bigBase64 = "a".repeat(3 * 1024 * 1024); // ~3MB, thừa sức vượt mọi limit nhỏ hơn
    const res = await postJson(base, "/posts/create", {
      _id: VALID_ID,
      authorId: OTHER_ID,
      content: "hello",
      media: [{ url: `data:image/png;base64,${bigBase64}` }],
      type: "create",
    });

    assert.equal(res.status, 200, "payload media 3MB phải lọt qua limit 50mb của post router");
    assert.equal((await res.json()).reached, true);
  });
});

// Chứng minh limit thật sự có hiệu lực (không phải "test nào cũng pass vì limit vô hạn"): CÙNG
// payload đó qua router limit 1mb thì bị chặn 413.
test("FR-2 (đối chứng): cùng payload 3MB qua router limit 1mb -> 413, không chạm controller", async () => {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.post("/t", reachedController);
  app.use(errorHandler);

  await withServer(app, async (base) => {
    const res = await postJson(base, "/t", { media: ["a".repeat(3 * 1024 * 1024)] });

    assert.equal(res.status, 413);
    assert.equal((await res.json()).type, "entity.too.large");
  });
});

/* --------------------------------------------------------------- util router: 100kb */

// AC FR-2: `sendForgotPWMail` chỉ nhận vài field text -> body > 100kb phải bị chặn TRƯỚC
// `validate()`/controller.
test("FR-2 (util router 100kb): sendForgotPWMail body > 100kb -> 413 trước validate/controller", async () => {
  const app = express();
  let controllerRan = false;
  app.use(express.json({ limit: "100kb" }));
  app.post(
    "/util/forgot-pw",
    validate(sendForgotPWMailSchema),
    (_req, res) => {
      controllerRan = true;
      res.json({ reached: true });
    }
  );
  app.use(errorHandler);

  await silenceWarn(() =>
    withServer(app, async (base) => {
      const res = await postJson(base, "/util/forgot-pw", {
        from: "a@b.com",
        to: "c@d.com",
        padding: "x".repeat(150 * 1024), // đệm cho vượt 100kb
      });

      assert.equal(res.status, 413);
      assert.equal((await res.json()).type, "entity.too.large");
      assert.equal(controllerRan, false, "413 phải xảy ra trước validate/controller");
    })
  );
});

test("FR-2 (util router 100kb, regression): body forgot-pw bình thường vẫn qua được", async () => {
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  app.post("/util/forgot-pw", validate(sendForgotPWMailSchema), reachedController);
  app.use(errorHandler);

  await withServer(app, async (base) => {
    const res = await postJson(base, "/util/forgot-pw", {
      from: "a@b.com",
      to: "c@d.com",
      subject: "reset",
      code: "123456",
      url: "https://example.com/reset",
    });
    assert.equal(res.status, 200);
  });
});

// AC FR-2: route UPLOAD là multipart -> `express.json({limit:"100kb"})` phải TỰ BỎ QUA theo
// Content-Type. File 200KB (vượt xa 100kb JSON limit, vẫn dưới 10MB của multer) phải upload OK.
// Dùng `upload` THẬT nên đây là bằng chứng end-to-end, không phải suy luận.
test("FR-2 (util router): multipart qua multer KHÔNG bị express.json 100kb chặn", async () => {
  const app = express();
  app.use(express.json({ limit: "100kb" })); // mount TRƯỚC, đúng như router.use trong util.route.ts
  app.post("/util/upload", upload.array("files"), (req: any, res) => {
    res.json({ ok: true, filesCount: (req.files as any[])?.length });
  });
  app.use(errorHandler);

  const uploadDir = `./uploads/${VALID_ID}`;
  try {
    await withServer(app, async (base) => {
      const form = new FormData();
      form.append("files", new Blob([Buffer.alloc(200 * 1024, "a")]), "big.txt");

      const res = await fetch(`${base}/util/upload?userId=${VALID_ID}`, {
        method: "POST",
        body: form,
      });

      assert.equal(res.status, 200, "multipart 200KB không được dính limit JSON 100kb");
      assert.equal((await res.json()).filesCount, 1);
    });
  } finally {
    await fsp.rm(uploadDir, { recursive: true, force: true });
  }
});

/* ------------------------------------------- message/analytics router: 1mb (regression) */

test("FR-2 (message router 1mb, regression): searchMsg body nhỏ hợp lệ vẫn parse bình thường", async () => {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.post("/messages/search", validate(searchMsgSchema), reachedController);
  app.use(errorHandler);

  await withServer(app, async (base) => {
    const res = await postJson(base, "/messages/search", {
      value: "hello",
      conversationId: VALID_ID,
      page: 1,
      limit: 20,
    });

    assert.equal(res.status, 200, "body nhỏ không được bị limit 1mb chặn nhầm");
    assert.equal((await res.json()).reached, true);
  });
});

test("FR-2 (analytics router 1mb, regression): createEvent kèm deviceInfo/browserInfo vẫn 200", async () => {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.post("/analytics/create", validate(createEventSchema), reachedController);
  app.use(errorHandler);

  await withServer(app, async (base) => {
    const res = await postJson(base, "/analytics/create", {
      userId: VALID_ID,
      event: "view_post",
      deviceInfo: { os: "iOS", version: "17.5" },
      browserInfo: { name: "safari" },
    });

    assert.equal(res.status, 200);
    assert.equal((await res.json()).reached, true);
  });
});

/* --------------------------------- source assertion (chống drift landmine parse-once) */

const readSrc = (path: string) => fsp.readFile(path, "utf8");

// Landmine cốt lõi của task: body-parser set `req._body` sau lần parse đầu, mọi `express.json()`
// sau đó trên CÙNG request bị skip. Nếu global 50mb ở `app.ts` quay lại, toàn bộ limit per-router
// dưới đây thành no-op mà không test hành vi nào fail. Vì vậy phải assert trực tiếp trên source.
test("FR-2: src/app.ts KHÔNG còn express.json global (parse-once landmine)", async () => {
  const src = await readSrc("src/app.ts");

  assert.ok(
    !/app\.use\(\s*express\.json\(/.test(src),
    "app.ts không được mount express.json global — sẽ vô hiệu hoá mọi limit per-router"
  );
  assert.ok(
    src.includes("app.use(express.urlencoded({ extended: false }))"),
    "urlencoded/cookieParser giữ nguyên, task này chỉ bỏ express.json"
  );
  assert.ok(src.includes("app.use(cookieParser())"));
});

const ROUTER_LIMITS: Array<[string, string]> = [
  ["src/api/routers/post.route.ts", "50mb"],
  ["src/api/routers/report.route.ts", "50mb"],
  ["src/api/routers/util.route.ts", "100kb"],
  ["src/api/routers/message.route.ts", "1mb"],
  ["src/api/routers/analytics.route.ts", "1mb"],
  ["src/api/routers/collection.route.ts", "1mb"],
  ["src/api/routers/notification.route.ts", "1mb"],
];

test("FR-2: đủ 7 router mount express.json đúng limit, TRƯỚC route đầu tiên", async () => {
  for (const [file, limit] of ROUTER_LIMITS) {
    const src = await readSrc(file);

    const mountIdx = src.indexOf(`router.use(express.json({ limit: "${limit}" }));`);
    assert.ok(mountIdx !== -1, `${file} phải mount express.json limit ${limit}`);

    const firstRouteIdx = src.search(/router\.(get|post|put|patch|delete)\(/);
    assert.ok(firstRouteIdx !== -1, `${file} phải có ít nhất 1 route`);
    assert.ok(
      mountIdx < firstRouteIdx,
      `${file}: express.json phải mount TRƯỚC route đầu tiên, nếu không route phía trên không có body`
    );
  }
});

// AD-4: quyết định có chủ đích — report router dùng blanket 50mb cho CẢ RESPONSE/REJECT (2 route
// không cần media). Comment phải còn để người đọc sau không tưởng là sót.
test("AD-4: report.route.ts có comment giải thích blanket 50mb", async () => {
  const src = await readSrc("src/api/routers/report.route.ts");
  assert.ok(
    src.includes("AD-4") && src.includes("RESPONSE/REJECT"),
    "phải ghi rõ blanket 50mb là quyết định có chủ đích, không phải sót per-route"
  );
});
