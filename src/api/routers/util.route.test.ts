// Run with Node's built-in test runner: `npm test`.
//
// Phạm vi: Task 015 — schema cho `util.route.ts` (FR-8).
//
// Pattern (task 001, AD-7): mount schema + `validate()` THẬT trên 1 `express()` mới, không import
// `util.route.ts` thật (route thật cần Cloudinary/Mongo cho controller). Riêng test "ordering" bên
// dưới là ngoại lệ CỐ Ý: mount `upload.array("files")` THẬT (từ `middlewares/upload.js`) cùng với
// `validate()` THẬT, vì đây là rủi ro hồi quy cao nhất của cả epic (ARCH-2, xem `015.md`) — chỉ có
// integration test đi qua multer thật mới bắt được lỗi thứ tự middleware.
import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import fsp from "node:fs/promises";
import express from "express";
import { validate, VALIDATION_ERROR_MESSAGE } from "../middlewares/validate.ts";
import { upload } from "../middlewares/upload.js";
import { sendForgotPWMailSchema, uploadSchema } from "../validators/util.validator.ts";
import logger from "../../core/logger.ts";

const VALID_ID = "652f1b2c3d4e5f6071829304";

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

/* --------------------------------------------- uploadSchema (schema-only, không cần multer) */

test("uploadSchema: thiếu query.userId -> 400", async () => {
  const app = express();
  app.use(express.json());
  app.post("/t", validate(uploadSchema), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);

  await silenceWarn(() =>
    withServer(app, async (base) => {
      const res = await fetch(`${base}/t`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filesName: "a.txt" }),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

test("uploadSchema: thiếu body.filesName -> 400", async () => {
  const app = express();
  app.use(express.json());
  app.post("/t", validate(uploadSchema), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);

  await silenceWarn(() =>
    withServer(app, async (base) => {
      const res = await fetch(`${base}/t?userId=${VALID_ID}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

/* --------------------------------------------- ordering integration (multer THẬT + validate THẬT) */

const UPLOAD_TEST_DIR = `./uploads/${VALID_ID}`;

test("FR-8 (ordering, ARCH-2): protectRoute -> upload.array -> validate -> handler, multipart hợp lệ -> tới được handler", async () => {
  const app = express();
  app.post(
    "/t",
    (_req, _res, next) => next(), // protectRoute stub
    upload.array("files"),
    validate(uploadSchema),
    (req: any, res) => {
      res.json({
        reachedHandler: true,
        filesName: req.body.filesName,
        filesCount: (req.files as any[])?.length,
      });
    }
  );
  app.use(errorHandler);

  try {
    await withServer(app, async (base) => {
      const form = new FormData();
      form.append("filesName", "hello.txt");
      form.append(
        "files",
        new Blob(["hello world"], { type: "text/plain" }),
        "hello.txt"
      );

      const res = await fetch(`${base}/t?userId=${VALID_ID}`, {
        method: "POST",
        body: form,
      });

      assert.equal(res.status, 200);
      const json: any = await res.json();
      assert.equal(json.reachedHandler, true);
      assert.equal(json.filesName, "hello.txt");
      assert.equal(json.filesCount, 1);
    });
  } finally {
    await fsp.rm(UPLOAD_TEST_DIR, { recursive: true, force: true });
  }
});

test("FR-8 (ordering): multipart thiếu filesName sau khi multer parse -> 400, không phải TypeError", async () => {
  const app = express();
  app.post(
    "/t",
    (_req, _res, next) => next(), // protectRoute stub
    upload.array("files"),
    validate(uploadSchema),
    (_req, res) => {
      res.json({ reachedHandler: true });
    }
  );
  app.use(errorHandler);

  try {
    await silenceWarn(() =>
      withServer(app, async (base) => {
        const form = new FormData();
        form.append(
          "files",
          new Blob(["hello world"], { type: "text/plain" }),
          "hello.txt"
        );
        // filesName cố ý bỏ trống

        const res = await fetch(`${base}/t?userId=${VALID_ID}`, {
          method: "POST",
          body: form,
        });

        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
      })
    );
  } finally {
    await fsp.rm(UPLOAD_TEST_DIR, { recursive: true, force: true });
  }
});

/* --------------------------------------------- sendForgotPWMailSchema */

test("sendForgotPWMailSchema: from không phải email hợp lệ -> 400", async () => {
  const app = express();
  app.use(express.json());
  app.post("/t", validate(sendForgotPWMailSchema), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);

  await silenceWarn(() =>
    withServer(app, async (base) => {
      const res = await fetch(`${base}/t`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          from: "not-an-email",
          to: "user@example.com",
          subject: "hi",
          code: "abc",
          url: "http://x",
        }),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

test("sendForgotPWMailSchema: payload hợp lệ đầy đủ -> 200", async () => {
  const app = express();
  app.use(express.json());
  app.post("/t", validate(sendForgotPWMailSchema), (req, res) => {
    res.json({ body: req.body });
  });
  app.use(errorHandler);

  const payload = {
    from: "from@example.com",
    to: "to@example.com",
    subject: "Forgot password",
    code: "abc123",
    url: "http://example.com/reset",
  };

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/t`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { body: payload });
  });
});

/* ------------------------------------------------- wiring (đọc source, không import) */

test("wiring: util.route.ts có đúng 2 validate(), upload.array đứng ngay trước validate(uploadSchema)", async () => {
  const src = await fsp.readFile("src/api/routers/util.route.ts", "utf8");

  const validateCount = (src.match(/validate\(/g) || []).length;
  assert.equal(validateCount, 2, "phải có đúng 2 lời gọi validate() trong util.route.ts");

  const uploadIdx = src.indexOf('upload.array("files")');
  const validateUploadIdx = src.indexOf("validate(uploadSchema)");
  assert.ok(uploadIdx !== -1 && validateUploadIdx !== -1);
  assert.ok(
    uploadIdx < validateUploadIdx,
    "upload.array(\"files\") phải đứng TRƯỚC validate(uploadSchema) trong chain"
  );
});
