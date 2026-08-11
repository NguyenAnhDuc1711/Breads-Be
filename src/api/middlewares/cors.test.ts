// Run with Node's built-in test runner: `npm test`.
//
// Phạm vi: Task 001 (security-hardening, FR-3) — `resolveAllowedOrigins()` (`utils/allowedOrigins.ts`)
// và hành vi CORS thật khi mount lên Express.
//
// 2 tầng, cố ý không thay thế nhau (AD-7, xem `validate.test.ts`):
//  - Tầng pure function: kiểm từng nhánh của `resolveAllowedOrigins` trực tiếp với env giả — bắt
//    buộc vì `ALLOWED_ORIGINS` (default export) được tính 1 LẦN lúc import module (ESM cache theo
//    tiến trình, xem `config.test.ts`), không thể tái tạo nhiều giá trị env trong cùng 1 lần chạy
//    test nếu chỉ đọc default export.
//  - Tầng HTTP thật: dựng `cors(corOption)` giống hệt cấu hình `app.ts` trên 1 `express()` mới
//    (KHÔNG import `app.ts` — file đó connect Mongo/Redis thật ngay lúc import), dùng list origin
//    trả về từ `resolveAllowedOrigins` để xác nhận `cors` middleware thật sự reject/accept đúng.
import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import cors from "cors";
import express from "express";
import { DEV_ORIGINS, resolveAllowedOrigins } from "../../utils/allowedOrigins.ts";

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

/** Mirror đúng `corOption` ở `src/app.ts` — chỉ đổi `origin` theo từng test case. */
const corsApp = (allowedOrigins: string[]) => {
  const app = express();
  app.use(
    cors({
      origin: allowedOrigins,
      methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
      preflightContinue: false,
      optionsSuccessStatus: 204,
      credentials: true,
    })
  );
  app.get("/t", (_req, res) => {
    res.json({ ok: true });
  });
  return app;
};

/* ---------------------------------------------------------- resolveAllowedOrigins (pure) */

test("resolveAllowedOrigins: env var set -> parse comma-separated, trim, bỏ rỗng, KHÔNG phụ thuộc NODE_ENV", () => {
  assert.deepEqual(
    resolveAllowedOrigins("https://a.com, https://b.com,,https://c.com", "production"),
    ["https://a.com", "https://b.com", "https://c.com"]
  );
  assert.deepEqual(
    resolveAllowedOrigins("https://a.com", "dev"),
    ["https://a.com"],
    "env var set thắng cả khi NODE_ENV=dev"
  );
});

test("resolveAllowedOrigins: env var không set + NODE_ENV=dev -> fallback DEV_ORIGINS (giữ trải nghiệm dev)", () => {
  assert.deepEqual(resolveAllowedOrigins(undefined, "dev"), DEV_ORIGINS);
});

test("resolveAllowedOrigins: env var không set + NODE_ENV=production -> [] (KHÔNG chứa localhost)", () => {
  const result = resolveAllowedOrigins(undefined, "production");
  assert.deepEqual(result, []);
  assert.ok(!result.some((o) => o.includes("localhost")));
});

test("resolveAllowedOrigins: env var không set + NODE_ENV bất kỳ giá trị khác 'dev' (kể cả undefined) -> [] (FR-3)", () => {
  for (const nodeEnv of [undefined, "production", "staging", "test"]) {
    const result = resolveAllowedOrigins(undefined, nodeEnv);
    assert.deepEqual(result, [], `NODE_ENV=${nodeEnv} phải trả về []`);
  }
});

test("resolveAllowedOrigins: env var rỗng ('') coi như không set -> theo nhánh NODE_ENV", () => {
  assert.deepEqual(resolveAllowedOrigins("", "dev"), DEV_ORIGINS);
  assert.deepEqual(resolveAllowedOrigins("", "production"), []);
});

/* ---------------------------------------------------------------------- HTTP thật */

test("CORS (HTTP thật): origin KHÔNG nằm trong allowlist + credentials -> response KHÔNG có Access-Control-Allow-Origin khớp origin đó", async () => {
  const app = corsApp(["https://allowed.example.com"]);

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/t`, {
      headers: { Origin: "https://evil.example.com" },
    });

    assert.notEqual(
      res.headers.get("access-control-allow-origin"),
      "https://evil.example.com"
    );
  });
});

test("CORS (HTTP thật): origin nằm trong allowlist (set qua resolveAllowedOrigins) -> request qua được, header khớp origin", async () => {
  const allowed = resolveAllowedOrigins("https://allowed.example.com", "production");
  const app = corsApp(allowed);

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/t`, {
      headers: { Origin: "https://allowed.example.com" },
    });

    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get("access-control-allow-origin"),
      "https://allowed.example.com"
    );
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test("CORS (HTTP thật): allowlist rỗng (production, không set env var) -> mọi origin đều bị reject", async () => {
  const allowed = resolveAllowedOrigins(undefined, "production");
  const app = corsApp(allowed);

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/t`, {
      headers: { Origin: "http://localhost:3000" },
    });

    assert.notEqual(
      res.headers.get("access-control-allow-origin"),
      "http://localhost:3000"
    );
  });
});

test("src/app.ts vẫn import ALLOWED_ORIGINS từ utils/allowedOrigins.ts và dùng chung 1 corOption cho cors()", async () => {
  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile("src/app.ts", "utf8")
  );

  assert.ok(src.includes('import ALLOWED_ORIGINS from "./utils/allowedOrigins.ts";'));
  assert.ok(src.includes("origin: ALLOWED_ORIGINS"));
});
