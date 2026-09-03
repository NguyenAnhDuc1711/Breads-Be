import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import express from "express";
import fs from "node:fs/promises";
import { validate, VALIDATION_ERROR_MESSAGE } from "../middlewares/validate.ts";
import {
  getConversationByUsersIdSchema,
  getConversationByIdQuerySchema,
  getConversationMediaSchema,
  getConversationFilesSchema,
  getConversationLinksSchema,
  searchMsgSchema,
  handleFakeConversationsSchema,
} from "../validators/message.validator.ts";
import { MESSAGE_PATH } from "../../Breads-Shared/APIConfig.js";
import logger from "../../core/logger.ts";

const VALID_ID_1 = "652f1b2c3d4e5f6071829304";
const VALID_ID_2 = "652f1b2c3d4e5f6071829305";

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

test("getConversationByUsersIdSchema: body hợp lệ -> 200", async () => {
  const app = express();
  app.use(express.json());
  app.post(
    "/t",
    validate(getConversationByUsersIdSchema),
    (req, res) => {
      res.json({ body: req.body });
    }
  );
  app.use(errorHandler);

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/t`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: VALID_ID_1, anotherId: VALID_ID_2 }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      body: { anotherId: VALID_ID_2 },
    });
  });
});

test("FR-6: getConversationByUsersIdSchema: thiếu anotherId -> 400", async () => {
  const app = express();
  app.use(express.json());
  app.post("/t", validate(getConversationByUsersIdSchema), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);

  await silenceWarn(() =>
    withServer(app, async (base) => {
      const res = await fetch(`${base}/t`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: VALID_ID_1 }),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

test("FR-6 (query-based route): getConversationByIdQuerySchema: conversationId không phải ObjectId -> 400", async () => {
  const app = express();
  app.get("/t", validate(getConversationByIdQuerySchema), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);

  await silenceWarn(() =>
    withServer(app, async (base) => {
      const res = await fetch(`${base}/t?conversationId=not-an-id`);
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

test("getConversationByIdQuerySchema: userId vắng mặt vẫn pass (optional)", async () => {
  const app = express();
  app.get("/t", validate(getConversationByIdQuerySchema), (req, res) => {
    res.json({ query: req.query });
  });
  app.use(errorHandler);

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/t?conversationId=${VALID_ID_1}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { query: { conversationId: VALID_ID_1 } });
  });
});

test("FR-6 (search minimum): searchMsgSchema: value rỗng -> 400", async () => {
  const app = express();
  app.use(express.json());
  app.post("/t", validate(searchMsgSchema), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);

  await silenceWarn(() =>
    withServer(app, async (base) => {
      const res = await fetch(`${base}/t`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          value: "",
          conversationId: VALID_ID_1,
          page: 1,
          limit: 10,
        }),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

test("searchMsgSchema: page/limit không phải số nguyên -> 400", async () => {
  const app = express();
  app.use(express.json());
  app.post("/t", validate(searchMsgSchema), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);

  await silenceWarn(() =>
    withServer(app, async (base) => {
      const res = await fetch(`${base}/t`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          value: "hello",
          conversationId: VALID_ID_1,
          page: 1.5,
          limit: 10,
        }),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

test("FR-3: searchMsgSchema.value chứa <script> bị strip sau transform", async () => {
  const app = express();
  app.use(express.json());
  let seenBody: any = null;
  app.post("/t", validate(searchMsgSchema), (req, res) => {
    seenBody = req.body;
    res.json({ ok: true });
  });
  app.use(errorHandler);

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/t`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        value: "<script>alert(1)</script>abc",
        conversationId: VALID_ID_1,
        page: 1,
        limit: 10,
      }),
    });
    assert.equal(res.status, 200);
    assert.ok(!seenBody.value.includes("<script>"), "script tag phải bị strip");
    assert.equal(seenBody.value, "abc");
  });
});

test("FR-5: searchMsgSchema.value tiếng Việt có dấu và emoji giữ nguyên", () => {
  const raw = "Xin chào các bạn 🎉";
  const parsed = searchMsgSchema.body.parse({
    value: raw,
    conversationId: VALID_ID_1,
    page: 1,
    limit: 10,
  });
  assert.equal(parsed.value, raw);
});

test("handleFakeConversationsSchema: numberConversations vắng mặt vẫn pass (optional, controller tự default)", async () => {
  const app = express();
  app.use(express.json());
  app.post("/t", validate(handleFakeConversationsSchema), (req, res) => {
    res.json({ body: req.body });
  });
  app.use(errorHandler);

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/t`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: VALID_ID_1 }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { body: { userId: VALID_ID_1 } });
  });
});

test("handleFakeConversationsSchema: numberConversations âm -> 400", async () => {
  const app = express();
  app.use(express.json());
  app.post("/t", validate(handleFakeConversationsSchema), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);

  await silenceWarn(() =>
    withServer(app, async (base) => {
      const res = await fetch(`${base}/t`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: VALID_ID_1, numberConversations: -1 }),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

test("FR-4 (task 012): getConversationMediaSchema: conversationId hợp lệ trong URL path -> 200, resolve từ req.params", async () => {
  const app = express();
  app.get(
    "/t/:conversationId",
    validate(getConversationMediaSchema),
    (req, res) => {
      res.json({ params: req.params });
    }
  );
  app.use(errorHandler);

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/t/${VALID_ID_1}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { params: { conversationId: VALID_ID_1 } });
  });
});

test("FR-4 (task 012): getConversationMediaSchema: conversationId không phải ObjectId trong path -> 400", async () => {
  const app = express();
  app.get(
    "/t/:conversationId",
    validate(getConversationMediaSchema),
    (_req, res) => {
      res.json({ ok: true });
    }
  );
  app.use(errorHandler);

  await silenceWarn(() =>
    withServer(app, async (base) => {
      const res = await fetch(`${base}/t/not-an-id`);
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

test("FR-4 (task 012): getConversationFilesSchema: conversationId hợp lệ trong URL path -> 200, resolve từ req.params", async () => {
  const app = express();
  app.get(
    "/t/:conversationId",
    validate(getConversationFilesSchema),
    (req, res) => {
      res.json({ params: req.params });
    }
  );
  app.use(errorHandler);

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/t/${VALID_ID_1}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { params: { conversationId: VALID_ID_1 } });
  });
});

test("FR-4 (task 012): getConversationFilesSchema: conversationId không phải ObjectId trong path -> 400", async () => {
  const app = express();
  app.get(
    "/t/:conversationId",
    validate(getConversationFilesSchema),
    (_req, res) => {
      res.json({ ok: true });
    }
  );
  app.use(errorHandler);

  await silenceWarn(() =>
    withServer(app, async (base) => {
      const res = await fetch(`${base}/t/not-an-id`);
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

test("FR-4 (task 012): getConversationLinksSchema: conversationId hợp lệ trong URL path -> 200, resolve từ req.params", async () => {
  const app = express();
  app.get(
    "/t/:conversationId",
    validate(getConversationLinksSchema),
    (req, res) => {
      res.json({ params: req.params });
    }
  );
  app.use(errorHandler);

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/t/${VALID_ID_1}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { params: { conversationId: VALID_ID_1 } });
  });
});

test("FR-4 (task 012): getConversationLinksSchema: conversationId không phải ObjectId trong path -> 400", async () => {
  const app = express();
  app.get(
    "/t/:conversationId",
    validate(getConversationLinksSchema),
    (_req, res) => {
      res.json({ ok: true });
    }
  );
  app.use(errorHandler);

  await silenceWarn(() =>
    withServer(app, async (base) => {
      const res = await fetch(`${base}/t/not-an-id`);
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

test("message.route.ts: validate() wired vào đúng 7/8 route (FAKE_CONVERSATIONS_MSGS không có schema)", async () => {
  const src = await fs.readFile("src/api/routers/message.route.ts", "utf8");
  const validateCalls = src.match(/validate\(/g) || [];
  assert.equal(validateCalls.length, 7, "phải có đúng 7 lần gọi validate(...)");

  const fakeMsgsCall = src.slice(src.lastIndexOf("FAKE_CONVERSATIONS_MSGS,"));
  assert.ok(
    !fakeMsgsCall.slice(0, fakeMsgsCall.indexOf(")")).includes("validate("),
    "route FAKE_CONVERSATIONS_MSGS (no-schema) không được wire validate()"
  );
});

const parseRouteLines = (src: string) =>
  src
    .split("\n")
    .join(" ")
    .match(/router\.(get|post|put|patch|delete)\([\s\S]*?\);/g) ?? [];

const parseRoutePairs = (src: string) =>
  parseRouteLines(src).map((line) => {
    const m = line.match(/^router\.(\w+)\(\s*("([^"]*)"|[A-Z_]+)/);
    assert.ok(m, `không parse được đối số path từ: ${line.slice(0, 80)}`);
    const [, method, rawArg, literal] = m;
    const path = literal !== undefined ? literal : (MESSAGE_PATH as any)[rawArg];
    assert.equal(
      typeof path,
      "string",
      `path của route ${method} không resolve được (${rawArg}) — constant có còn trong MESSAGE_PATH?`
    );
    return [method, path];
  });

test("FR-4 (task 012): 8 endpoint messages đúng method + path RESTful mới, đúng thứ tự đăng ký", async () => {
  const src = await fs.readFile("src/api/routers/message.route.ts", "utf8");
  const pairs = parseRoutePairs(src);

  assert.deepEqual(pairs, [
    ["post", "/conversations/lookup-by-users"],
    ["get", "/conversations/:conversationId"],
    ["get", "/conversations/:conversationId/media"],
    ["get", "/conversations/:conversationId/files"],
    ["get", "/conversations/:conversationId/links"],
    ["post", "/search"],
    ["post", "/conversations/seed"],
    ["post", "/conversations/seed-messages"],
  ]);
});

test("FR-4 (task 012, id-source): getConversationMedia/Files/Links đọc req.params.conversationId, KHÔNG đọc req.body", async () => {
  const src = await fs.readFile("src/api/controllers/message.controller.ts", "utf8");

  for (const fnName of [
    "getConversationMedia",
    "getConversationFiles",
    "getConversationLinks",
  ]) {
    const start = src.indexOf(`export const ${fnName} = async`);
    assert.ok(start >= 0, `không tìm thấy hàm ${fnName} trong message.controller.ts`);
    const fn = src.slice(start, src.indexOf("\n};", start));

    assert.ok(
      fn.includes("const { conversationId } = req.params;"),
      `${fnName} phải lấy conversationId từ req.params (route GET /conversations/:conversationId/...)`
    );
    assert.ok(
      !fn.includes("req.body"),
      `${fnName} không được đọc req.body — GET request không mang body`
    );
  }
});

test("FR-10 (task 012): message.controller.ts không còn raw res.json({ error ... })", async () => {
  const src = await fs.readFile("src/api/controllers/message.controller.ts", "utf8");
  assert.equal(
    (src.match(/\.json\(\{\s*error/g) ?? []).length,
    0,
    "mọi lỗi phải `throw new {XxxError}` để app.ts error-handler soạn envelope thống nhất"
  );
});
