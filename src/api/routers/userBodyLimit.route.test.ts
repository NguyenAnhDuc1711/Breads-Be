import assert from "node:assert/strict";
import { once } from "node:events";
import fsp from "node:fs/promises";
import { test } from "node:test";
import express from "express";
import { USER_PATH } from "../../Breads-Shared/APIConfig.ts";
import logger from "../../core/logger.ts";
import { validate } from "../middlewares/validate.ts";
import * as userValidators from "../validators/user.validator.ts";

const SRC_PATH = "src/api/routers/user.route.ts";
const VALID_ID = "652f1b2c3d4e5f6071829304";
const OTHER_ID = "652f1b2c3d4e5f6071829305";

type ParsedRoute = {
  method: "get" | "post" | "put";
  key: string;
  path: string;
  jsonLimit: string | null;
  jsonArgIndex: number;
  schemaName: string | null;
  hasProtectRoute: boolean;
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

const parseRouter = (src: string): ParsedRoute[] => {
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
      jsonArgIndex: args.findIndex((a) => a.startsWith("express.json(")),
      schemaName: schema ? schema[1] : null,
      hasProtectRoute: /\bprotectRoute\b/.test(rest),
    });
  }
  return routes;
};

const parsedRoutes = parseRouter(await fsp.readFile(SRC_PATH, "utf8"));

const EXPECTED_LIMITS: Record<string, string | null> = {
  SIGN_UP: "100kb",
  LOGIN: "100kb",
  FOLLOW: "100kb",
  CHANGE_PW: "100kb",
  PW_RESET_REQUEST: "100kb",
  PW_RESET_VERIFY: "100kb",
  PW_RESET_CONFIRM: "100kb",
  VALIDATE_USER_EMAIL: "100kb",
  GET_USERS_PENDING_POST: "100kb",
  UPDATE: "50mb",
  ME: null,
  PROFILE: null,
  USERS_FOLLOW: null,
  USERS_TO_FOLLOW: null,
  USERS_TO_TAG: null,
  GET_USERS_WITH_STATUS: null,
  LOGOUT: null,
  CRAWL_USER: null,
  REFRESH_TOKEN: null,
  SITEMAP_ELIGIBLE: null,
  ADMIN_DETAIL: null,
  ADMIN_ACTION: "100kb",
};

const REQUESTS: Record<string, { query?: string; body?: unknown }> = {
  ME: {},
  PROFILE: {},
  USERS_FOLLOW: { query: `?userId=${VALID_ID}&type=followed&page=1&limit=20` },
  USERS_TO_FOLLOW: { query: `?userId=${VALID_ID}&page=1&limit=10` },
  USERS_TO_TAG: { query: `?userId=${VALID_ID}&searchValue=an` },
  GET_USERS_WITH_STATUS: { query: `?userId=${VALID_ID}&page=1&limit=10` },
  GET_USERS_PENDING_POST: {
    body: { userId: VALID_ID, page: 1, limit: 10, searchValue: "an" },
  },
  SIGN_UP: {
    body: {
      name: "An",
      email: "an@example.com",
      username: "an",
      password: "secret1",
    },
  },
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
  SITEMAP_ELIGIBLE: {},
  ADMIN_DETAIL: {},
  ADMIN_ACTION: { body: { role: 1 } },
};

const errorHandler = (err, _req, res, _next) => {
  res
    .status(err.statusCode || err.status || 500)
    .json({ message: err.message, type: err.type });
};

const reachedController = (req, res) => {
  res.json({ reached: true, bodyKeys: Object.keys(req.body ?? {}).length });
};

const buildAppFromSource = (routes: ParsedRoute[] = parsedRoutes) => {
  const app = express();
  for (const route of routes) {
    const chain: any[] = [];
    if (route.jsonLimit) chain.push(express.json({ limit: route.jsonLimit }));
    if (route.schemaName) chain.push(validate(userValidators[route.schemaName]));
    app[route.method](route.path, ...chain, reachedController);
  }
  app.use(errorHandler);
  return app;
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

const silenceWarn = async (fn: () => unknown | Promise<unknown>) => {
  const original = logger.warn;
  (logger as any).warn = () => {};
  try {
    return await fn();
  } finally {
    (logger as any).warn = original;
  }
};

const urlFor = (route: ParsedRoute) =>
  route.path.replace(":userId", VALID_ID).replace(":id", VALID_ID) +
  (REQUESTS[route.key].query ?? "");

const send = (base: string, route: ParsedRoute, body?: unknown) =>
  fetch(`${base}${urlFor(route)}`, {
    method: route.method.toUpperCase(),
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });

test("FR-2: user.route.ts có ĐÚNG 22 route, không thiếu không thừa so với bảng 011.md + SITEMAP_ELIGIBLE task 003 + ADMIN_DETAIL/ADMIN_ACTION (Users module) + password-reset (bước 2)", () => {
  assert.equal(parsedRoutes.length, 22, "phải parse ra đúng 22 route");
  assert.deepEqual(
    parsedRoutes.map((r) => r.key).sort(),
    Object.keys(EXPECTED_LIMITS).sort(),
    "danh sách route trong source phải khớp 1-1 với bảng route của task + SITEMAP_ELIGIBLE task 003, trừ ADMIN"
  );
});

test("FR-2: mỗi route mount ĐÚNG limit của nó (10×100kb + 1×50mb + 11×không mount)", () => {
  for (const route of parsedRoutes) {
    assert.equal(
      route.jsonLimit,
      EXPECTED_LIMITS[route.key],
      `route ${route.key} sai limit body-parser`
    );
  }

  const at = (limit: string | null) =>
    parsedRoutes.filter((r) => r.jsonLimit === limit).length;
  assert.equal(at("100kb"), 10);
  assert.equal(at("50mb"), 1);
  assert.equal(
    at(null),
    11,
    "9 route gốc (ADMIN đã gỡ) + SITEMAP_ELIGIBLE (task 003) + ADMIN_DETAIL (Users module)"
  );
  assert.equal(at("100kb") + at("50mb") + at(null), 22);
});

test("FR-2: mọi route có `.body` trong user.validator.ts đều PHẢI có express.json (và ngược lại)", () => {
  for (const route of parsedRoutes) {
    const schema = route.schemaName ? userValidators[route.schemaName] : null;
    const needsBody = Boolean(schema?.body);
    assert.equal(
      Boolean(route.jsonLimit),
      needsBody,
      needsBody
        ? `route ${route.key} đọc .body nhưng KHÔNG mount express.json -> req.body === undefined khi deploy`
        : `route ${route.key} không đọc .body nhưng lại mount express.json thừa`
    );
  }
  assert.equal(parsedRoutes.filter((r) => r.jsonLimit).length, 11);
});

test("FR-2: user.route.ts KHÔNG mount express.json ở cấp router", async () => {
  const src = await fsp.readFile(SRC_PATH, "utf8");
  const code = src.replace(/^\s*\/\/.*$/gm, "");
  assert.ok(
    !/router\.use\(\s*express\.json\(/.test(code),
    "router này lẫn 2 nhóm payload -> chỉ được mount per-route"
  );
});

test("FR-2: express.json luôn là middleware ĐẦU TIÊN (trước protectRoute/validate)", () => {
  const mounted = parsedRoutes.filter((r) => r.jsonLimit);
  assert.equal(mounted.length, 11, "phải kiểm tra đủ 11 route có express.json");

  for (const route of mounted) {
    assert.equal(
      route.jsonArgIndex,
      1,
      `${route.key}: express.json phải đứng ngay sau path, trước mọi middleware khác`
    );
  }
});

test("FR-2 (SMOKE 22/22): mọi route xử lý bình thường, không route nào lỗi do req.body undefined", async () => {
  const app = buildAppFromSource();
  const failures: string[] = [];

  await silenceWarn(() =>
    withServer(app, async (base) => {
      for (const route of parsedRoutes) {
        const spec = REQUESTS[route.key];
        const res = await send(base, route, spec.body);
        const payload = await res.json().catch(() => ({}));

        if (res.status !== 200) {
          failures.push(
            `${route.method.toUpperCase()} ${route.key} -> ${res.status} ${payload.message ?? ""}`
          );
          continue;
        }
        if (spec.body && payload.bodyKeys === 0) {
          failures.push(
            `${route.key} trả 200 nhưng req.body rỗng -> thiếu express.json`
          );
        }
      }
    })
  );

  assert.deepEqual(failures, [], `21 route phải pass hết:\n${failures.join("\n")}`);
});

test("FR-2 (đối chứng): gỡ express.json khỏi route có body -> 400 vì req.body undefined", async () => {
  const stripped = parsedRoutes.map((r) => ({ ...r, jsonLimit: null }));
  const app = buildAppFromSource(stripped);
  const target = parsedRoutes.find((r) => r.key === "SIGN_UP")!;

  await silenceWarn(() =>
    withServer(app, async (base) => {
      const res = await send(base, target, REQUESTS.SIGN_UP.body);
      assert.equal(res.status, 400, "không có body-parser thì validate phải fail");
    })
  );
});

test("FR-2: SIGN_UP/LOGIN với body > 100kb -> 413 trước validate/controller", async () => {
  const app = buildAppFromSource();

  await silenceWarn(() =>
    withServer(app, async (base) => {
      for (const key of ["SIGN_UP", "LOGIN"]) {
        const route = parsedRoutes.find((r) => r.key === key)!;
        const res = await send(base, route, {
          ...(REQUESTS[key].body as object),
          padding: "x".repeat(150 * 1024),
        });

        assert.equal(res.status, 413, `${key} body > 100kb phải bị chặn`);
        assert.equal((await res.json()).type, "entity.too.large");
      }
    })
  );
});

test("FR-2: UPDATE với avatar base64 ~3MB vẫn 200, không bị áp nhầm limit 100kb", async () => {
  const app = buildAppFromSource();
  const route = parsedRoutes.find((r) => r.key === "UPDATE")!;

  await withServer(app, async (base) => {
    const res = await send(base, route, {
      name: "An",
      avatar: `data:image/png;base64,${"a".repeat(3 * 1024 * 1024)}`,
    });

    assert.equal(res.status, 200, "route avatar phải giữ limit 50mb riêng");
    assert.ok((await res.json()).bodyKeys > 0);
  });
});

test("FR-2: nhóm route từng bị quên (FOLLOW/CHANGE_PW/password-reset/...) parse body bình thường", async () => {
  const app = buildAppFromSource();
  const keys = [
    "FOLLOW",
    "CHANGE_PW",
    "PW_RESET_REQUEST",
    "PW_RESET_VERIFY",
    "PW_RESET_CONFIRM",
    "VALIDATE_USER_EMAIL",
    "GET_USERS_PENDING_POST",
  ];

  await silenceWarn(() =>
    withServer(app, async (base) => {
      for (const key of keys) {
        const route = parsedRoutes.find((r) => r.key === key)!;
        const res = await send(base, route, REQUESTS[key].body);
        const payload = await res.json();

        assert.equal(res.status, 200, `${key} phải xử lý được payload hợp lệ`);
        assert.ok(payload.bodyKeys > 0, `${key} nhận req.body rỗng`);
      }
    })
  );
});

test("FR-2: 11 route không mount body-parser (GET listing + LOGOUT + CRAWL_USER + REFRESH_TOKEN + SITEMAP_ELIGIBLE + ADMIN_DETAIL) vẫn 200", async () => {
  const app = buildAppFromSource();
  const noParser = parsedRoutes.filter((r) => !r.jsonLimit);
  assert.equal(noParser.length, 11);

  await silenceWarn(() =>
    withServer(app, async (base) => {
      for (const route of noParser) {
        const res = await send(base, route, REQUESTS[route.key].body);
        assert.equal(res.status, 200, `${route.key} không được regression`);
      }
    })
  );
});
