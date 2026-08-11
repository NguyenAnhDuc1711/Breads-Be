// Run with Node's built-in test runner: `npm test`.
//
// Phạm vi: Task 013 (security-hardening, FR-5) — sanitize NoSQL operator injection
// (express-mongo-sanitize) + HTTP Parameter Pollution (hpp), mount router.use() ở cả 8 router file
// (7 router thuần từ Task 010 + user.route.ts, xem Anchor Code trong 013.md).
//
// Không import route file trực tiếp (AD-7 — controller mở Mongo/Redis/Cloudinary lúc import).
// mongoSanitize/hpp tự thân không đụng DB, an toàn import trực tiếp để test hành vi; wiring trong
// từng router file được xác nhận bằng cách đọc source (giống Task 010/011/012).
import assert from "node:assert/strict";
import { once } from "node:events";
import fsp from "node:fs/promises";
import { test } from "node:test";
import express from "express";
import mongoSanitize from "express-mongo-sanitize";
import hpp from "hpp";

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

const postJson = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/* ------------------------------------------------------------------- hành vi: mongoSanitize */

test("FR-5: key bắt đầu bằng $ trong req.body bị strip trước khi tới handler", async () => {
  const app = express();
  app.use(express.json());
  app.use(mongoSanitize());
  app.post("/t", (req, res) => res.json({ body: req.body }));

  await withServer(app, async (base) => {
    const res = await postJson(base, "/t", { email: { $ne: null }, password: "x" });
    const { body } = await res.json();
    assert.deepEqual(body.email, {}, "operator $ne phải bị strip, chỉ còn object rỗng");
    assert.equal(body.password, "x", "field hợp lệ khác không bị đụng");
  });
});

test("FR-5: key chứa dấu . trong req.body bị strip", async () => {
  const app = express();
  app.use(express.json());
  app.use(mongoSanitize());
  app.post("/t", (req, res) => res.json({ body: req.body }));

  await withServer(app, async (base) => {
    const res = await postJson(base, "/t", { "a.b": "x", normal: "y" });
    const { body } = await res.json();
    assert.equal(body["a.b"], undefined, "key chứa dấu . phải bị strip");
    assert.equal(body.normal, "y");
  });
});

test("FR-5: key $ trong req.query cũng bị strip (không chỉ req.body)", async () => {
  const app = express();
  app.use(mongoSanitize());
  app.get("/t", (req, res) => res.json({ query: req.query }));

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/t?${encodeURIComponent("$where")}=1&safe=2`);
    const { query } = await res.json();
    assert.equal(query.$where, undefined, "operator $ trong query phải bị strip");
    assert.equal(query.safe, "2");
  });
});

/* ---------------------------------------------------------------------------- hành vi: hpp */

test("FR-5: hpp giữ giá trị CUỐI CÙNG khi query key lặp lại, không truyền array", async () => {
  const app = express();
  app.use(hpp());
  app.get("/t", (req, res) => res.json({ page: req.query.page }));

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/t?page=1&page=2`);
    const { page } = await res.json();
    assert.equal(page, "2", "hpp mặc định giữ giá trị CUỐI CÙNG");
    assert.ok(!Array.isArray(page), "không được truyền array xuống handler/service");
  });
});

/* ---------------------------------------------------------- không strip nhầm dữ liệu hợp lệ */

test("FR-5: tên tiếng Việt có dấu và ký tự đặc biệt hợp lệ (không phải $/.) không bị strip", async () => {
  const app = express();
  app.use(express.json());
  app.use(mongoSanitize());
  app.post("/t", (req, res) => res.json({ body: req.body }));

  await withServer(app, async (base) => {
    const res = await postJson(base, "/t", {
      name: "Nguyễn Văn Ánh",
      bio: "yêu đời! #vibe @all 100%",
    });
    const { body } = await res.json();
    assert.equal(body.name, "Nguyễn Văn Ánh");
    assert.equal(body.bio, "yêu đời! #vibe @all 100%");
  });
});

/* ------------------------------------------------------- tích hợp: injection không gây lỗi 500 */

test("FR-5 (tích hợp): payload injection tới route có validate() không gây lỗi 500, operator đã bị strip trước Zod", async () => {
  const { z } = await import("zod");
  const loginSchema = {
    body: z.object({ email: z.string().email(), password: z.string().min(1) }),
  };
  const { validate } = await import("./validate.ts");

  const app = express();
  app.use(express.json());
  app.use(mongoSanitize());
  app.post("/login", validate(loginSchema), (req, res) =>
    res.json({ reached: true, body: req.body })
  );
  app.use((err: any, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ message: err.message });
  });

  await withServer(app, async (base) => {
    // $ne bị strip -> field `email` còn lại {} (object rỗng, không phải operator injection nữa)
    // -> Zod reject vì {} không phải email hợp lệ (400, KHÔNG PHẢI 500 do injection lọt xuống DB).
    const res = await postJson(base, "/login", {
      email: { $ne: null },
      password: "anything",
    });
    assert.notEqual(res.status, 500, "injection không được gây lỗi 500 (nghĩa là đã lọt xuống DB)");
    assert.equal(res.status, 400, "Zod phải reject vì email không còn là operator, chỉ là object rỗng");
  });
});

/* ------------------------------------------------------------- source assertion: wiring đủ 8 file */

const readSrc = (path: string) => fsp.readFile(path, "utf8");

const ROUTER_FILES = [
  "src/api/routers/post.route.ts",
  "src/api/routers/report.route.ts",
  "src/api/routers/util.route.ts",
  "src/api/routers/message.route.ts",
  "src/api/routers/analytics.route.ts",
  "src/api/routers/collection.route.ts",
  "src/api/routers/notification.route.ts",
  "src/api/routers/user.route.ts",
];

test("FR-5: đủ 8/8 router file mount router.use(mongoSanitize()) + router.use(hpp())", async () => {
  for (const file of ROUTER_FILES) {
    const src = await readSrc(file);
    assert.ok(
      src.includes("router.use(mongoSanitize())"),
      `${file} thiếu router.use(mongoSanitize())`
    );
    assert.ok(src.includes("router.use(hpp())"), `${file} thiếu router.use(hpp())`);
  }
});

test("FR-5: KHÔNG mount mongoSanitize/hpp ở app.ts cấp global (phải nằm trong router, sau body-parser)", async () => {
  const src = await readSrc("src/app.ts");
  assert.ok(!src.includes("mongoSanitize"), "app.ts không được import/mount mongoSanitize");
  assert.ok(!src.includes("import hpp"), "app.ts không được import/mount hpp");
});

// `user.route.ts` là router DUY NHẤT có body-parser PER-ROUTE (Task 011), không phải router.use()
// cấp file — router.use(mongoSanitize()) ở đầu file chạy TRƯỚC mọi express.json per-route, nên
// KHÔNG sanitize được req.body (chỉ query/params). 9 route có `.body` phải tự có mongoSanitize()/
// hpp() riêng NGAY SAU express.json của route đó — nếu không, injection trong body sẽ lọt qua.
test("FR-5: 9 route có .body trong user.route.ts đều có mongoSanitize()/hpp() riêng SAU express.json của chính route đó", async () => {
  const src = await readSrc("src/api/routers/user.route.ts");
  const code = src.replace(/^\s*\/\/.*$/gm, "");
  const re = /router\.(get|post|put)\(/g;
  let m: RegExpExecArray | null;
  const bodyRoutesChecked: string[] = [];

  while ((m = re.exec(code))) {
    let depth = 1;
    let i = re.lastIndex;
    while (depth > 0) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")") depth--;
      i++;
    }
    const chain = code.slice(re.lastIndex, i - 1);
    if (!chain.includes("express.json(")) continue; // route không có .body, bỏ qua

    const jsonIdx = chain.indexOf("express.json(");
    const jsonEndIdx = chain.indexOf(")", jsonIdx) + 2; // qua dấu `),`
    const afterJson = chain.slice(jsonEndIdx);
    assert.ok(
      afterJson.trimStart().startsWith("mongoSanitize()"),
      `route tại vị trí ${jsonIdx}: mongoSanitize() phải đứng NGAY SAU express.json để sanitize được req.body — chain: ${chain.slice(0, 80)}`
    );
    bodyRoutesChecked.push(chain.slice(0, 30));
  }

  assert.equal(bodyRoutesChecked.length, 9, "phải kiểm tra đủ 9 route có .body");
});

test("FR-5: ở 7 router thuần, mongoSanitize/hpp mount SAU express.json (để req.body đã parse)", async () => {
  const PURE_ROUTERS = ROUTER_FILES.filter((f) => !f.includes("user.route"));
  for (const file of PURE_ROUTERS) {
    const src = await readSrc(file);
    const jsonIdx = src.search(/router\.use\(\s*express\.json\(/);
    const sanitizeIdx = src.indexOf("router.use(mongoSanitize())");
    assert.ok(jsonIdx !== -1, `${file} phải có express.json (từ task 010)`);
    assert.ok(
      jsonIdx < sanitizeIdx,
      `${file}: mongoSanitize phải mount SAU express.json`
    );
  }
});
