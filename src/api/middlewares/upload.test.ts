// Run with Node's built-in test runner: `npm test`.
//
// Phạm vi: Task 002 (security-hardening, FR-2) — giới hạn dung lượng/file và số file/request cho
// `multer` (`upload.ts`), và nhánh `MulterError` mới trong error handler cuối `src/app.ts`.
//
// KHÔNG import `src/app.ts` trực tiếp (connect Mongo/Redis thật ngay lúc import, AD-7 — xem
// `errorHandler.test.ts`/`util.route.test.ts`). Thay vào đó: mirror ĐÚNG logic error handler thật
// (bao gồm nhánh MulterError mới) lên 1 `express()` mới, mount `upload` THẬT (từ `upload.ts`, cùng
// limits thật) để test hành vi HTTP thật qua multer thật — đây là rủi ro hồi quy cao nhất của task
// này (limit sai hoặc thứ tự nhánh sai trong error handler). Cuối file có 1 test đọc source
// `src/app.ts` để xác nhận app.ts thật giữ đúng logic đã mirror (chống drift).
import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { STATUS_CODES } from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import express from "express";
import multer from "multer";
import {
  upload,
  MAX_FILE_SIZE_BYTES,
  MAX_FILES_PER_REQUEST,
  validateUploadUserId,
  rejectUnsupportedFileTypes,
} from "./upload.ts";
import { ErrorResponse } from "../../core/error.response.ts";

const MULTER_ERROR_MESSAGES: Record<string, string> = {
  LIMIT_FILE_SIZE: "File quá lớn",
  LIMIT_FILE_COUNT: "Quá nhiều file trong 1 request",
};

/** Mirror ĐÚNG logic error handler cuối `src/app.ts` (dòng ~59-77), bao gồm nhánh MulterError mới
 * (task 002) CHÈN TRƯỚC nhánh generic của task 001. */
const makeErrorHandler = (isDevEnv: boolean) => (err, _req, res, _next) => {
  const isMulterError = err instanceof multer.MulterError;
  const statusCode = isMulterError ? 413 : err.statusCode || err.status || 500;
  const isKnownBusinessError = err instanceof ErrorResponse;
  const message = isMulterError
    ? MULTER_ERROR_MESSAGES[err.code] || err.message || "Lỗi upload file"
    : isDevEnv || isKnownBusinessError
      ? err.message || "Internal Server Error"
      : STATUS_CODES[statusCode] || "Internal Server Error";

  res.status(statusCode).json({ status: "error", code: statusCode, message });
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

const USER_ID = "652f1b2c3d4e5f6071829304";
const UPLOAD_TEST_DIR = `./uploads/${USER_ID}`;

const cleanupUploadDir = () => fsp.rm(UPLOAD_TEST_DIR, { recursive: true, force: true });

/* --------------------------------------------------------- limits config (upload.ts) */

test("upload.ts: MAX_FILE_SIZE_BYTES mặc định 10MB, MAX_FILES_PER_REQUEST mặc định 10 (không set env override)", () => {
  assert.equal(MAX_FILE_SIZE_BYTES, 10 * 1024 * 1024);
  assert.equal(MAX_FILES_PER_REQUEST, 10);
});

/* --------------------------------------------------------- FR-2 HTTP integration (multer THẬT) */

test("FR-2: upload 1 file vượt fileSize cấu hình -> 413, message riêng LIMIT_FILE_SIZE (không phải 500/generic)", async () => {
  const app = express();
  app.post("/t", upload.array("files"), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(makeErrorHandler(false));

  try {
    await withServer(app, async (base) => {
      const oversized = Buffer.alloc(MAX_FILE_SIZE_BYTES + 1024, "a");
      const form = new FormData();
      form.append("files", new Blob([oversized], { type: "image/png" }), "big.bin");

      const res = await fetch(`${base}/t?userId=${USER_ID}`, {
        method: "POST",
        body: form,
      });

      assert.equal(res.status, 413);
      const body: any = await res.json();
      assert.equal(body.message, "File quá lớn");
    });
  } finally {
    await cleanupUploadDir();
  }
});

test("FR-2: upload số file vượt files cấu hình -> 413, không có file nào được ghi xuống disk", async () => {
  const app = express();
  app.post("/t", upload.array("files"), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(makeErrorHandler(false));

  try {
    await withServer(app, async (base) => {
      const form = new FormData();
      for (let i = 0; i < MAX_FILES_PER_REQUEST + 1; i++) {
        form.append("files", new Blob([`hello-${i}`], { type: "text/plain" }), `f${i}.txt`);
      }

      const res = await fetch(`${base}/t?userId=${USER_ID}`, {
        method: "POST",
        body: form,
      });

      assert.equal(res.status, 413);
      const body: any = await res.json();
      assert.equal(body.message, "Quá nhiều file trong 1 request");

      let filesOnDisk: string[] = [];
      try {
        filesOnDisk = await fsp.readdir(UPLOAD_TEST_DIR);
      } catch {
        // dir không tồn tại -> chắc chắn không có file nào bị ghi, hợp lệ
      }
      assert.equal(filesOnDisk.length, 0, "multer phải dừng trước khi ghi file vượt giới hạn");
    });
  } finally {
    await cleanupUploadDir();
  }
});

test("FR-2 (regression): upload file/số lượng hợp lệ trong giới hạn -> vẫn thành công như trước", async () => {
  const app = express();
  app.post("/t", upload.array("files"), (req: any, res) => {
    res.json({ ok: true, filesCount: (req.files as any[])?.length });
  });
  app.use(makeErrorHandler(false));

  try {
    await withServer(app, async (base) => {
      const form = new FormData();
      form.append("files", new Blob(["hello world"], { type: "text/plain" }), "hello.txt");

      const res = await fetch(`${base}/t?userId=${USER_ID}`, {
        method: "POST",
        body: form,
      });

      assert.equal(res.status, 200);
      const body: any = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.filesCount, 1);
    });
  } finally {
    await cleanupUploadDir();
  }
});

/* --------------------------------------------------------- S2: sanitize userId + fileFilter */

test("S2: userId không phải ObjectId hợp lệ (path traversal) -> 400, không tạo thư mục/ghi file nào", async () => {
  const app = express();
  app.post(
    "/t",
    validateUploadUserId,
    upload.array("files"),
    rejectUnsupportedFileTypes,
    (_req, res) => {
      res.json({ ok: true });
    }
  );
  app.use(makeErrorHandler(false));

  const traversalDir = "./uploads/../evil";
  try {
    await withServer(app, async (base) => {
      const form = new FormData();
      form.append("files", new Blob(["hello"], { type: "text/plain" }), "hello.txt");

      const res = await fetch(`${base}/t?userId=${encodeURIComponent("../evil")}`, {
        method: "POST",
        body: form,
      });

      assert.equal(res.status, 400);
      const body: any = await res.json();
      assert.equal(body.message, "Invalid userId");
      assert.equal(fs.existsSync(traversalDir), false, "không được tạo thư mục ngoài ./uploads");
    });
  } finally {
    await fsp.rm(traversalDir, { recursive: true, force: true });
  }
});

test("S2: mimetype không nằm trong whitelist (ảnh/video/tài liệu) -> 400, không ghi file xuống disk", async () => {
  const app = express();
  app.post(
    "/t",
    validateUploadUserId,
    upload.array("files"),
    rejectUnsupportedFileTypes,
    (_req, res) => {
      res.json({ ok: true });
    }
  );
  app.use(makeErrorHandler(false));

  try {
    await withServer(app, async (base) => {
      const form = new FormData();
      form.append(
        "files",
        new Blob(["#!/bin/sh\necho pwned"], { type: "application/x-sh" }),
        "evil.sh"
      );

      const res = await fetch(`${base}/t?userId=${USER_ID}`, {
        method: "POST",
        body: form,
      });

      assert.equal(res.status, 400);
      const body: any = await res.json();
      assert.equal(body.message, "Unsupported file type: application/x-sh");

      let filesOnDisk: string[] = [];
      try {
        filesOnDisk = await fsp.readdir(UPLOAD_TEST_DIR);
      } catch {
        // dir không tồn tại -> chắc chắn không có file nào bị ghi, hợp lệ
      }
      assert.equal(filesOnDisk.length, 0);
    });
  } finally {
    await cleanupUploadDir();
  }
});

test("FR-2 (ordering): nhánh MulterError chạy TRƯỚC nhánh generic — message riêng, không phải STATUS_CODES[413]/\"Internal Server Error\"", async () => {
  const app = express();
  app.post("/t", upload.array("files"), (_req, res) => {
    res.json({ ok: true });
  });
  // isDevEnv=false, err KHÔNG phải ErrorResponse -> nếu nhánh MulterError không chạy TRƯỚC, nhánh
  // generic của T001 sẽ set message = STATUS_CODES[413] ("Payload Too Large"), không phải message
  // riêng cho LIMIT_FILE_SIZE.
  app.use(makeErrorHandler(false));

  try {
    await withServer(app, async (base) => {
      const oversized = Buffer.alloc(MAX_FILE_SIZE_BYTES + 1024, "a");
      const form = new FormData();
      form.append("files", new Blob([oversized], { type: "image/png" }), "big.bin");

      const res = await fetch(`${base}/t?userId=${USER_ID}`, {
        method: "POST",
        body: form,
      });

      const body: any = await res.json();
      assert.notEqual(body.message, STATUS_CODES[413]);
      assert.notEqual(body.message, "Internal Server Error");
      assert.equal(body.message, "File quá lớn");
    });
  } finally {
    await cleanupUploadDir();
  }
});

/* ------------------------------------------------- source assertion (chống drift, AD-7) */

test("src/app.ts (source thật) giữ đúng logic FR-2: nhánh MulterError chèn TRƯỚC isKnownBusinessError, statusCode 413", async () => {
  const src = await fsp.readFile("src/app.ts", "utf8");

  assert.ok(
    src.includes('import multer from "multer";'),
    "phải import multer để dùng multer.MulterError"
  );
  assert.ok(
    src.includes("err instanceof multer.MulterError"),
    "phải nhận diện MulterError qua instanceof multer.MulterError"
  );

  const isMulterErrorIdx = src.indexOf("const isMulterError = err instanceof multer.MulterError");
  const isKnownBusinessErrorIdx = src.indexOf("const isKnownBusinessError = err instanceof ErrorResponse");
  assert.ok(isMulterErrorIdx !== -1 && isKnownBusinessErrorIdx !== -1);
  assert.ok(
    isMulterErrorIdx < isKnownBusinessErrorIdx,
    "nhánh MulterError phải được tính TRƯỚC nhánh generic/isKnownBusinessError của T001"
  );

  assert.ok(
    src.includes("LIMIT_FILE_SIZE: \"File quá lớn\""),
    "phải có message riêng cho LIMIT_FILE_SIZE"
  );
  assert.ok(
    src.includes("LIMIT_FILE_COUNT: \"Quá nhiều file trong 1 request\""),
    "phải có message riêng cho LIMIT_FILE_COUNT"
  );
  assert.ok(
    src.includes("isMulterError ? 413"),
    "MulterError phải luôn map statusCode 413"
  );
});
