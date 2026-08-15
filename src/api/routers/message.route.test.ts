// Run with Node's built-in test runner: `npm test`.
//
// Phạm vi: Task 013 — 7 schema của router `message`.
//
// Pattern (task 001, AD-7): mount `validate(schema)` trần trên 1 `express()` mới, không import
// `app.ts`/`message.route.ts` thật (route thật còn `protectRoute` cần Mongo/JWT) — không cần
// Mongo/Redis, vẫn kiểm đúng mã lỗi HTTP THẬT trả về client.
import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import express from "express";
import fs from "node:fs/promises";
import { validate, VALIDATION_ERROR_MESSAGE } from "../middlewares/validate.ts";
import {
  getConversationByUsersIdSchema,
  getConversationByIdQuerySchema,
  searchMsgSchema,
  handleFakeConversationsSchema,
} from "../validators/message.validator.ts";
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

/* --------------------------------------------- getConversationByUsersIdSchema (body) */

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
      body: { userId: VALID_ID_1, anotherId: VALID_ID_2 },
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

/* ------------------------------------------- getConversationByIdQuerySchema (query) */

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

/* --------------------------------------------------------------- searchMsgSchema (body) */

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

// AC FR-3 scenario 2 (task 010): searchMsgSchema.value là field free-text API-side duy nhất trong
// file này, tương đương `searchValue` bên socket đã có `sanitizeText` từ lâu.
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

// AC FR-5 (non-regression): tiếng Việt có dấu / emoji không bị strip nhầm.
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

/* ------------------------------------------------ handleFakeConversationsSchema (body) */

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

/* --------------------------------------------------------------------- wiring/structure */

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
