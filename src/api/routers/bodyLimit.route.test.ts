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
import { requestPasswordResetSchema } from "../validators/user.validator.ts";

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

const reachedController = (req, res) => {
  res.json({ reached: true, contentLength: JSON.stringify(req.body ?? {}).length });
};

const postJson = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("FR-2 (post router 50mb): createPost với media base64 ~3MB vẫn 200, không bị 413", async () => {
  const app = express();
  app.use(express.json({ limit: "50mb" }));
  app.post("/posts/create", validate(createPostSchema), reachedController);
  app.use(errorHandler);

  await withServer(app, async (base) => {
    const bigBase64 = "a".repeat(3 * 1024 * 1024);
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

test("FR-2 (user router 100kb): password-reset body > 100kb -> 413 trước validate/controller", async () => {
  const app = express();
  let controllerRan = false;
  app.use(express.json({ limit: "100kb" }));
  app.post(
    "/util/forgot-pw",
    validate(requestPasswordResetSchema),
    (_req, res) => {
      controllerRan = true;
      res.json({ reached: true });
    }
  );
  app.use(errorHandler);

  await silenceWarn(() =>
    withServer(app, async (base) => {
      const res = await postJson(base, "/util/forgot-pw", {
        email: "c@d.com",
        padding: "x".repeat(150 * 1024),
      });

      assert.equal(res.status, 413);
      assert.equal((await res.json()).type, "entity.too.large");
      assert.equal(controllerRan, false, "413 phải xảy ra trước validate/controller");
    })
  );
});

test("FR-2 (user router 100kb, regression): body password-reset bình thường vẫn qua được", async () => {
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  app.post("/util/forgot-pw", validate(requestPasswordResetSchema), reachedController);
  app.use(errorHandler);

  await withServer(app, async (base) => {
    const res = await postJson(base, "/util/forgot-pw", { email: "c@d.com" });
    assert.equal(res.status, 200);
  });
});

test("FR-2 (util router): multipart qua multer KHÔNG bị express.json 100kb chặn", async () => {
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  app.post("/util/upload", upload.array("files"), (req: any, res) => {
    res.json({ ok: true, filesCount: (req.files as any[])?.length });
  });
  app.use(errorHandler);

  const uploadDir = `./uploads/${VALID_ID}`;
  try {
    await withServer(app, async (base) => {
      const form = new FormData();
      form.append("files", new Blob([Buffer.alloc(200 * 1024, "a")], { type: "text/plain" }), "big.txt");

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

const readSrc = (path: string) => fsp.readFile(path, "utf8");

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
