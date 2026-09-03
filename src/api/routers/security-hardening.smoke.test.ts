// Run with Node's built-in test runner: `npm test`.
//
// Phạm vi: Task 020 (security-hardening, NFR-2) — smoke test TỔNG HỢP xác nhận toàn bộ Phase 2
// (T010 express.json per-router, T011 express.json per-route user.route.ts, T012 rate-limit,
// T013 sanitize/HPP) cộng lại KHÔNG phá behavior cũ, đặc biệt trên `user.route.ts` (18 route, nơi
// đã có tiền lệ lỗi "quên route" 2 lần khi soạn PRD) và các route/flow PRD gọi tên tường minh phải
// giữ nguyên: CRAWL_POST, CRAWL_USER, cron job, Socket.IO handshake.
//
// KHÔNG test lại chi tiết hành vi MỚI của từng task (đã có ở bodyLimit/userBodyLimit/rateLimiter/
// sanitize .test.ts riêng) — chỉ xác nhận KHÔNG REGRESSION khi TẤT CẢ middleware chạy CÙNG LÚC.
//
// AD-7: không import route file / cronjob/index.ts / socket.ts's listener chain trực tiếp nếu có
// nguy cơ mở Mongo/Redis lúc import và giữ event loop sống (đã tự kiểm chứng: import
// `src/cronjob/index.ts` treo process — xem "Test 3" bên dưới dùng source-check thay vì import).
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import fsp from "node:fs/promises";
import { test } from "node:test";
import express from "express";
import mongoSanitize from "express-mongo-sanitize";
import hpp from "hpp";
import { USER_PATH } from "../../Breads-Shared/APIConfig.ts";
import { authTierLimiter } from "../middlewares/rateLimiter.ts";
import { validate } from "../middlewares/validate.ts";
import * as userValidators from "../validators/user.validator.ts";
import { createPostSchema } from "../validators/post.validator.ts";
import { sendReportSchema } from "../validators/report.validator.ts";
import { updateUserSchema } from "../validators/user.validator.ts";

const VALID_ID = "652f1b2c3d4e5f6071829304";
const OTHER_ID = "652f1b2c3d4e5f6071829305";

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

const silence = async (fn: () => unknown | Promise<unknown>) => {
  const loggerMod = await import("../../core/logger.ts");
  const original = loggerMod.default.warn;
  (loggerMod.default as any).warn = () => {};
  try {
    return await fn();
  } finally {
    (loggerMod.default as any).warn = original;
  }
};

/* ============================================================================================
   Test 1 — 18/18 route user.route.ts, chain ĐẦY ĐỦ (express.json + mongoSanitize + hpp +
   authTierLimiter khi có + validate), không chỉ express.json+validate như userBodyLimit test.
   ============================================================================================ */

type ParsedRoute = {
  method: "get" | "post" | "put";
  key: string;
  path: string;
  jsonLimit: string | null;
  hasSanitize: boolean;
  hasAuthLimiter: boolean;
  schemaName: string | null;
};

const splitTopLevel = (args: string) => {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of args) {
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
};

const resolvePath = (expr: string) =>
  expr
    .split("+")
    .map((raw) => {
      const token = raw.trim();
      const quoted = token.match(/^"([^"]*)"$/);
      if (quoted) return quoted[1];
      const value = USER_PATH[token];
      assert.equal(typeof value, "string", `USER_PATH.${token} phải tồn tại`);
      return value;
    })
    .join("");

const parseUserRouter = (src: string): ParsedRoute[] => {
  const code = src.replace(/^\s*\/\/.*$/gm, "");
  const routes: ParsedRoute[] = [];
  const re = /router\.(get|post|put)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    let depth = 1;
    let i = re.lastIndex;
    while (depth > 0) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")") depth--;
      i++;
    }
    const args = splitTopLevel(code.slice(re.lastIndex, i - 1));
    const pathExpr = args[0];
    const rest = args.slice(1).join(",");
    const limit = rest.match(/express\.json\(\{\s*limit:\s*"([^"]+)"\s*\}\)/);
    const schema = rest.match(/validate\((\w+)\)/);
    routes.push({
      method: m[1] as ParsedRoute["method"],
      key: pathExpr.split("+")[0].trim(),
      path: resolvePath(pathExpr),
      jsonLimit: limit ? limit[1] : null,
      hasSanitize: rest.includes("mongoSanitize()"),
      hasAuthLimiter: /(?<!Tier)authTierLimiter/.test(rest),
      schemaName: schema ? schema[1] : null,
    });
  }
  return routes;
};

const parsedUserRoutes = parseUserRouter(
  await fsp.readFile("src/api/routers/user.route.ts", "utf8")
);

const REQUESTS: Record<string, { query?: string; body?: unknown }> = {
  ME: {},
  PROFILE: {},
  USERS_FOLLOW: { query: `?userId=${VALID_ID}&type=followed&page=1&limit=20` },
  USERS_TO_FOLLOW: { query: `?userId=${VALID_ID}&page=1&limit=10` },
  USERS_TO_TAG: { query: `?userId=${VALID_ID}&searchValue=an` },
  GET_USERS_WITH_STATUS: { query: `?userId=${VALID_ID}&page=1&limit=10` },
  GET_USERS_PENDING_POST: { body: { userId: VALID_ID, page: 1, limit: 10, searchValue: "an" } },
  SIGN_UP: { body: { name: "An", email: "an@example.com", username: "an", password: "secret1" } },
  LOGIN: { body: { email: "an@example.com", password: "secret1" } },
  LOGOUT: {},
  FOLLOW: { body: { userFlId: OTHER_ID, userId: VALID_ID } },
  UPDATE: { body: { name: "An", avatar: "data:image/png;base64,aaaa" } },
  CHANGE_PW: { body: { currentPW: "old-secret", newPW: "new-secret" } },
  CRAWL_USER: {},
  PW_RESET_REQUEST: { body: { email: "an@example.com" } },
  PW_RESET_VERIFY: { body: { email: "an@example.com", code: "A1b2C3" } },
  PW_RESET_CONFIRM: { body: { userId: VALID_ID, code: "A1b2C3", newPW: "new-secret" } },
  VALIDATE_USER_EMAIL: { body: { email: "an@example.com", code: "123456" } },
  REFRESH_TOKEN: {},
  ADMIN_DETAIL: {},
  ADMIN_ACTION: { body: { role: 1 } },
};

const buildFullUserApp = () => {
  const app = express();
  for (const route of parsedUserRoutes) {
    const chain: any[] = [];
    if (route.jsonLimit) chain.push(express.json({ limit: route.jsonLimit }));
    if (route.hasSanitize) chain.push(mongoSanitize(), hpp());
    // authTierLimiter cố ý KHÔNG chèn ở đây: dùng chung 1 instance sẽ làm smoke test (18 route,
    // gọi 1 lần/route) tự đụng ngưỡng 5/phút của chính nó ở 3 route SIGN_UP/LOGIN/CRAWL_USER nếu
    // test file khác cũng đã gọi cùng route trước đó trong cùng lần chạy `npm test` (singleton
    // module-level). Test 2 riêng verify authTierLimiter có mặt qua wiring (rateLimiter.test.ts).
    if (route.schemaName) chain.push(validate(userValidators[route.schemaName]));
    app[route.method](route.path, ...chain, (req, res) =>
      res.json({ reached: true, bodyKeys: Object.keys(req.body ?? {}).length })
    );
  }
  app.use((err: any, _req, res, _next) => {
    res.status(err.statusCode || err.status || 500).json({ message: err.message, type: err.type });
  });
  return app;
};

const urlFor = (route: ParsedRoute) =>
  route.path.replace(":userId", VALID_ID).replace(":id", VALID_ID) +
  (REQUESTS[route.key]?.query ?? "");

const send = (base: string, route: ParsedRoute) =>
  fetch(`${base}${urlFor(route)}`, {
    method: route.method.toUpperCase(),
    ...(REQUESTS[route.key]?.body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(REQUESTS[route.key].body),
        }),
  });

// 21 + 3 route password-reset (bước 2) - 2 route dò tài khoản đã xoá (bước 6) = 22.
test("NFR-2 (SMOKE 22/22): mọi route user.route.ts hoạt động bình thường với TOÀN BỘ middleware Phase 2 (express.json+mongoSanitize+hpp+validate) cùng lúc", async () => {
  // Task 003 (epic seo-sitemap-schema): 19 -> 20 route sau khi thêm SITEMAP_ELIGIBLE; sau đó
  // security-hardening gỡ backdoor GET /admin (không xác thực) -> 20 -> 19. Users module
  // (Breads-Admin): +ADMIN_DETAIL/+ADMIN_ACTION -> 19 -> 21.
  assert.equal(parsedUserRoutes.length, 22, "phải parse đủ 22 route");
  const app = buildFullUserApp();
  const failures: string[] = [];

  await silence(() =>
    withServer(app, async (base) => {
      for (const route of parsedUserRoutes) {
        const res = await send(base, route);
        const payload = await res.json().catch(() => ({}));
        if (res.status !== 200) {
          failures.push(`${route.method.toUpperCase()} ${route.key} -> ${res.status} ${payload.message ?? ""}`);
          continue;
        }
        if (REQUESTS[route.key]?.body && payload.bodyKeys === 0) {
          failures.push(`${route.key} trả 200 nhưng req.body rỗng`);
        }
      }
    })
  );

  assert.deepEqual(failures, [], `22 route phải pass hết:\n${failures.join("\n")}`);
});

/* ============================================================================================
   Test 2 — CRAWL_POST / CRAWL_USER: KHÔNG bị loại trừ khỏi rate-limit (AD-3), nhưng lần gọi ĐẦU
   TIÊN vẫn phải qua được (không 429 ngay, không lỗi body-parser).
   ============================================================================================ */

test("NFR-2: CRAWL_POST/CRAWL_USER vẫn hoạt động bình thường ở lần gọi đầu (có authTierLimiter nhưng chưa vượt ngưỡng)", async () => {
  const app = express();
  app.post("/crawl-post", authTierLimiter, (_req, res) => res.json({ reached: true }));
  app.post("/crawl-user", authTierLimiter, (_req, res) => res.json({ reached: true }));

  await withServer(app, async (base) => {
    const postRes = await fetch(`${base}/crawl-post`, { method: "POST" });
    assert.equal(postRes.status, 200, "CRAWL_POST phải qua được ở lần gọi đầu");

    const userRes = await fetch(`${base}/crawl-user`, { method: "POST" });
    assert.equal(userRes.status, 200, "CRAWL_USER phải qua được ở lần gọi đầu");
  });
});

test("NFR-2 (wiring): CRAWL_POST/CRAWL_USER thật sự có authTierLimiter trong source (AD-3 — không loại trừ)", async () => {
  const postSrc = await fsp.readFile("src/api/routers/post.route.ts", "utf8");
  const userSrc = await fsp.readFile("src/api/routers/user.route.ts", "utf8");
  assert.ok(
    postSrc.replace(/^\s*\/\/.*$/gm, "").includes("router.post(CRAWL_POST, authTierLimiter,"),
    "CRAWL_POST phải có authTierLimiter"
  );
  assert.ok(
    userSrc.replace(/^\s*\/\/.*$/gm, "").includes("router.post(CRAWL_USER, authTierLimiter,"),
    "CRAWL_USER phải có authTierLimiter"
  );
});

/* ============================================================================================
   Test 3 — cron job: KHÔNG import trực tiếp `src/cronjob/index.ts` (đã tự kiểm chứng: import file
   này giữ event loop sống >10s do kéo theo feed services mở Redis lúc import — treo `npm test`).
   Thay vào đó xác nhận qua SOURCE: 2 hàm export dùng `cron.schedule` (chỉ ĐĂNG KÝ job, không có
   side-effect đồng bộ lúc gọi) và KHÔNG đụng gì tới rate-limiter/HTTP (cron không qua HTTP nên
   không thể bị rate-limit ảnh hưởng — đúng ý NFR-2's scenario).
   ============================================================================================ */

test("NFR-2: cron job (updateUsersCatesCron) không đụng rate-limit, chỉ đăng ký cron.schedule", async () => {
  const src = await fsp.readFile("src/cronjob/index.ts", "utf8");
  assert.ok(src.includes("export const updateUsersCatesCron"));
  assert.ok(
    !/rateLimiter|RateLimiter|authTierLimiter|globalTierLimiter/.test(src),
    "cron job không đi qua HTTP -> không được/không cần đụng rate-limit middleware"
  );
  const scheduleCount = (src.match(/cron\.schedule\(/g) || []).length;
  assert.equal(scheduleCount, 1, "updateUsersCatesCron phải dùng cron.schedule (đăng ký job, không side-effect đồng bộ lúc gọi)");
});

/* ============================================================================================
   Test 4 — Socket.IO handshake: gọi initSocket() thật trên 1 http.Server thật, xác nhận request
   polling handshake (engine.io) vẫn trả về response hợp lệ sau khi ALLOWED_ORIGINS đổi nguồn ở
   T001. KHÔNG thêm dependency `socket.io-client` mới (đúng gợi ý trong 020.md) — dùng `fetch` thô
   tới endpoint polling, đủ để xác nhận `initSocket`/`ALLOWED_ORIGINS` wiring không bị vỡ.
   Không assert CORS-reject ở đây (đã tự kiểm chứng: engine.io polling GET không trả
   Access-Control-Allow-Origin cho request không có preflight, kể cả origin hợp lệ lẫn origin lạ —
   hành vi này của engine.io/socket.io, không phải lỗi do epic; CORS-reject cho socket đã nằm ngoài
   khả năng verify an toàn bằng fetch thô, cần test thủ công với client thật/browser).
   ============================================================================================ */

test("NFR-2: Socket.IO handshake (initSocket + ALLOWED_ORIGINS mới) vẫn hoạt động, không throw, trả response hợp lệ", async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-smoke-test";
  const { initSocket } = await import("../../socket/socket.ts");

  const server = http.createServer((_req, res) => res.end("http-ok"));
  const fakeApp = { set: () => {} } as any;

  assert.doesNotThrow(() => initSocket(server, fakeApp), "initSocket không được throw sau khi ALLOWED_ORIGINS đổi nguồn (T001)");

  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const port = (server.address() as any).port;
    const res = await fetch(`http://127.0.0.1:${port}/socket/?EIO=4&transport=polling`, {
      headers: { Origin: "http://localhost:3000" },
    });
    assert.equal(res.status, 200, "engine.io handshake phải trả 200");
    const body = await res.text();
    assert.ok(body.startsWith("0{"), "response phải là engine.io OPEN packet hợp lệ (bắt đầu bằng '0{')");
  } finally {
    server.close();
    await once(server, "close");
  }
});

/* ============================================================================================
   Test 5 — Regression media base64: createPost / report-CREATE / UPDATE-avatar vẫn nhận media
   base64 vài MB thành công với TOÀN BỘ middleware Phase 2 (không chỉ express.json như T010/T011
   đã test riêng — lần này thêm cả mongoSanitize/hpp chạy chung).
   ============================================================================================ */

test("NFR-2: createPost với media base64 ~3MB vẫn 200 (express.json 50mb + mongoSanitize + hpp cùng lúc)", async () => {
  const app = express();
  app.use(express.json({ limit: "50mb" }));
  app.use(mongoSanitize());
  app.use(hpp());
  app.post("/posts", validate(createPostSchema), (req, res) =>
    res.json({ reached: true, mediaCount: (req.body as any)?.media?.length })
  );
  app.use((err: any, _req, res, _next) => res.status(err.statusCode || 500).json({ message: err.message }));

  await withServer(app, async (base) => {
    const bigBase64 = "a".repeat(3 * 1024 * 1024);
    const res = await fetch(`${base}/posts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        _id: VALID_ID,
        authorId: OTHER_ID,
        content: "hello",
        media: [{ url: `data:image/png;base64,${bigBase64}` }],
        type: "create",
      }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).mediaCount, 1);
  });
});

test("NFR-2: report CREATE với media base64 ~3MB vẫn 200 (express.json 50mb + mongoSanitize + hpp cùng lúc)", async () => {
  const app = express();
  app.use(express.json({ limit: "50mb" }));
  app.use(mongoSanitize());
  app.use(hpp());
  app.post("/reports", validate(sendReportSchema), (req, res) =>
    res.json({ reached: true, mediaCount: (req.body as any)?.media?.length ?? 0 })
  );
  app.use((err: any, _req, res, _next) => res.status(err.statusCode || 500).json({ message: err.message }));

  await withServer(app, async (base) => {
    const bigBase64 = "a".repeat(3 * 1024 * 1024);
    const res = await fetch(`${base}/reports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: VALID_ID,
        content: "spam report",
        media: [{ url: `data:image/png;base64,${bigBase64}` }],
      }),
    });
    assert.equal(res.status, 200, `report CREATE phải qua được với media 3MB (got ${res.status})`);
  });
});

test("NFR-2: UPDATE user (avatar) với base64 ~3MB vẫn 200 (express.json 50mb + mongoSanitize + hpp per-route cùng lúc)", async () => {
  const app = express();
  app.post(
    "/users/:id",
    express.json({ limit: "50mb" }),
    mongoSanitize(),
    hpp(),
    validate(updateUserSchema),
    (req, res) => res.json({ reached: true, bodyKeys: Object.keys(req.body ?? {}).length })
  );
  app.use((err: any, _req, res, _next) => res.status(err.statusCode || 500).json({ message: err.message }));

  await withServer(app, async (base) => {
    const bigBase64 = "a".repeat(3 * 1024 * 1024);
    const res = await fetch(`${base}/users/${VALID_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "An", avatar: `data:image/png;base64,${bigBase64}` }),
    });
    assert.equal(res.status, 200);
    assert.ok((await res.json()).bodyKeys > 0);
  });
});
