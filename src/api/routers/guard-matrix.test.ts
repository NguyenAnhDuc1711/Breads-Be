// Run with Node's built-in test runner: `npm test`.
//
// Bước 7 (epic access-control-hardening) — CƠ CHẾ CHỐNG TÁI PHÁT.
//
// Sáu bước trước bịt các lỗ ĐÃ BIẾT. File này ngăn lỗ MỚI: nó duyệt toàn bộ router và bắt mọi route
// không có guard phải được khai báo công khai một cách TƯỜNG MINH, kèm lý do. Quên `protectRoute`
// từ nay là CI đỏ, không còn là một lỗ hổng im lặng.
//
// Vì sao đọc source thay vì import router thật: `post.route.ts` kéo theo `feed/queue.ts` mở kết nối
// Redis ngay lúc import (xem comment đầu `post.route.test.ts`), nên import nó trong CI — nơi không
// có Redis — sẽ treo. Đây cũng đúng cách 4 test wiring sẵn có trong repo đang làm.
//
// Test này CỐ Ý bắt 2 LỚP LỖI KHÁC NHAU, vì chúng độc lập với nhau:
//   (a) route thiếu guard          -> danh tính không tồn tại, controller buộc phải tin client
//   (b) route có guard nhưng schema vẫn khai báo `userId`/`authorId` trong body/query
//       -> danh tính tồn tại nhưng bị bỏ qua (chính là lỗ hổng V4: `PUT /users/follow` đã có
//          `protectRoute` từ trước mà vẫn cho ép user khác follow)
import assert from "node:assert/strict";
import { test } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const ROUTER_DIR = "src/api/routers";
const VALIDATOR_DIR = "src/api/validators";

/** Middleware CHỨNG MINH được danh tính người gọi. */
const IDENTITY_GUARDS = ["protectRoute", "sitemapAuthGate"];

/** Biết-là-ai-nếu-có: route công khai có chủ đích nhưng vẫn phân biệt được người xem. */
const SOFT_GUARDS = ["optionalAuth"];

/**
 * Danh sách route CÔNG KHAI có chủ đích — mọi entry phải kèm lý do.
 *
 * Đây là bề mặt tấn công tự khai báo của hệ thống: thêm một dòng vào đây là một quyết định bảo mật,
 * và nó hiện ra trong diff của PR thay vì lẩn trong một chuỗi middleware dài. Key có dạng
 * `<file> <METHOD> <token>`, với `token` là literal path hoặc TÊN CONSTANT như trong source —
 * cố ý không resolve constant thành đường dẫn thật để entry vẫn đọc được khi so với code.
 */
const PUBLIC_ROUTES: Record<string, string> = {
  // --- users: đăng ký / đăng nhập / khôi phục phiên ---
  'user.route.ts POST SIGN_UP': "đăng ký — chưa có danh tính để chứng minh (có authTierLimiter)",
  'user.route.ts POST LOGIN': "đăng nhập — chính là nơi danh tính được tạo (có authTierLimiter)",
  'user.route.ts POST LOGOUT': "huỷ phiên bằng refresh cookie; không đọc dữ liệu của ai",
  'user.route.ts POST REFRESH_TOKEN': "đổi refresh cookie lấy access token — bản thân cookie LÀ chứng cứ",
  'user.route.ts POST VALIDATE_USER_EMAIL': "xác nhận mã email lúc đăng ký, chưa có tài khoản",
  'user.route.ts POST PW_RESET_REQUEST': "quên mật khẩu — người dùng theo định nghĩa không đăng nhập được",
  'user.route.ts POST PW_RESET_VERIFY': "đối chiếu mã OTP do server phát hành; mã LÀ chứng cứ",
  'user.route.ts POST PW_RESET_CONFIRM': "đặt lại mật khẩu bằng mã OTP; mã LÀ chứng cứ",

  // --- users: dữ liệu công khai ---
  'user.route.ts GET PROFILE': "trang cá nhân công khai, SEO index được",
  'user.route.ts GET USERS_FOLLOW': "danh sách follower/following công khai",
  'user.route.ts GET USERS_TO_FOLLOW': "gợi ý follow cho cả khách chưa đăng nhập",

  // --- seed/dev tool ---
  'user.route.ts POST CRAWL_USER': "tool seed dữ liệu; chưa có auth guard — chỉ authTierLimiter (nợ kỹ thuật đã biết, PRD C-4)",
  'post.route.ts POST CRAWL_POST': "tool seed dữ liệu; chưa có auth guard — chỉ authTierLimiter (nợ kỹ thuật đã biết, PRD C-4)",

  // --- analytics: ghi sự kiện từ client ẩn danh ---
  'analytics.route.ts POST CREATE': "ghi sự kiện tracking từ khách chưa đăng nhập — đúng mục đích đo lường",
  'analytics.route.ts GET GET': "hiện là stub trả mảng rỗng, chưa có logic đọc (analytics.controller.ts)",
};

/**
 * Route BẮT BUỘC có guard PHÂN QUYỀN ở tầng route (không chỉ xác thực).
 *
 * Vì sao cần thêm bảng này: 3 test phía trên chỉ kiểm XÁC THỰC (`protectRoute` — "anh là ai"),
 * không kiểm PHÂN QUYỀN (`requireRole`/`requireSelfOnParam` — "anh được làm gì"). Một route
 * admin-only âm thầm mất `requireRole` vẫn qua sạch mọi kiểm tra cũ.
 *
 * Đây không phải giả thuyết: `PATCH /posts/:id/status` ĐÃ mất `requireRole` trong lúc làm epic này
 * và không test nào bắt được. Endpoint vẫn an toàn nhờ `assertRole` trong controller (đúng lý do
 * lớp phòng thủ thứ hai được giữ lại ở bước 10) — nhưng "an toàn nhờ may" không phải thiết kế.
 *
 * Giá trị của mỗi entry là lý do; danh sách role cụ thể vẫn đọc ở source route.
 */
const ROLE_GUARDED_ROUTES: Record<string, string> = {
  "post.route.ts PATCH UPDATE_POST_STATUS": "duyệt/gỡ bài — hành động kiểm duyệt, ADMIN/MODERATOR",
  "report.route.ts GET REPORT_PATH.GET": "hàng đợi report — ADMIN/MODERATOR",
  "report.route.ts GET REPORT_PATH.GET_BY_USER": "lịch sử report của 1 user — ADMIN",
  "report.route.ts PATCH REPORT_PATH.RESPONSE": "trả lời report + gửi mail — ADMIN/MODERATOR",
  "report.route.ts PATCH REPORT_PATH.REJECT": "từ chối report — ADMIN/MODERATOR",
  "user.route.ts GET GET_USERS_WITH_STATUS": "danh sách user cho Admin app — ADMIN",
  "user.route.ts GET ADMIN_DETAIL": "chi tiết user (email/role/status) — ADMIN",
  "user.route.ts PUT ADMIN_ACTION": "đổi role/status của user khác — ADMIN",
  "user.route.ts PUT UPDATE": "sửa hồ sơ — chính chủ hoặc ADMIN",
  "user.route.ts PUT CHANGE_PW": "đổi mật khẩu — chính chủ hoặc ADMIN",
  "collection.route.ts GET /:userId": "bài đã lưu — chỉ chính chủ",
  "collection.route.ts PATCH ADD": "bài đã lưu — chỉ chính chủ",
  "collection.route.ts DELETE REMOVE": "bài đã lưu — chỉ chính chủ",
};

/** Middleware trả lời "được làm gì", khác `IDENTITY_GUARDS` vốn chỉ trả lời "là ai". */
const AUTHZ_GUARDS = ["requireRole", "requireSelfOrRole", "requireSelfOnParam"];

/* ------------------------------------------------------------------ parsing */

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

type ParsedRoute = {
  file: string;
  method: string;
  token: string;
  chain: string;
  /** Guard mount ở cấp router (`router.use(protectRoute)`), áp cho MỌI route trong cùng file. */
  routerLevelGuards: string[];
  key: string;
};

/**
 * `notification.route.ts` mount `router.use(protectRoute)` một lần cho cả file thay vì lặp trên
 * từng route — hoàn toàn hợp lệ, và là pattern mà `docs/architecture-review.md` khuyến nghị khi fix
 * S5. Bỏ sót nhánh này thì test sẽ báo động giả trên đúng router ĐANG được bảo vệ tốt nhất.
 */
const parseRouterLevelGuards = (code: string): string[] =>
  [...IDENTITY_GUARDS, ...SOFT_GUARDS].filter((g) =>
    new RegExp(`router\\.use\\(\\s*${g}\\s*\\)`).test(code)
  );

/**
 * `\);` làm mốc kết thúc là an toàn với style hiện tại của repo: mọi lời gọi lồng bên trong
 * (`validate(x)`, `express.json({...})`, `asyncHandler(f)`) đều kết thúc bằng `),` hoặc `})`, chỉ
 * lời gọi `router.*` ngoài cùng mới kết thúc bằng `);`.
 */
const parseRoutes = (file: string, src: string): ParsedRoute[] => {
  const code = stripComments(src);
  const routerLevelGuards = parseRouterLevelGuards(code);
  const matches = code.match(/router\.(get|post|put|patch|delete)\([\s\S]*?\);/g) ?? [];
  return matches.map((chain) => {
    // `[A-Za-z_][\w.]*` chứ không chỉ `\w+`: path có thể là `NOTIFICATION_PATH.GET` (không
    // destructure) chứ không riêng constant trần như `ME`. Bắt thiếu phần sau dấu chấm sẽ làm 2
    // route khác nhau cùng file gộp thành 1 key trùng nhau.
    const m = chain.match(/^router\.(\w+)\(\s*("([^"]*)"|[A-Za-z_][A-Za-z0-9_.]*)/);
    assert.ok(m, `${file}: không parse được đối số path từ "${chain.slice(0, 60)}"`);
    const [, method, rawArg, literal] = m!;
    const token = literal !== undefined ? literal : rawArg;
    return {
      file,
      method: method.toUpperCase(),
      token,
      chain,
      routerLevelGuards,
      key: `${file} ${method.toUpperCase()} ${token}`,
    };
  });
};

const loadAllRoutes = async (): Promise<ParsedRoute[]> => {
  const files = (await readdir(ROUTER_DIR))
    .filter((f) => f.endsWith(".route.ts"))
    .sort();
  const all: ParsedRoute[] = [];
  for (const f of files) {
    all.push(...parseRoutes(f, await readFile(path.join(ROUTER_DIR, f), "utf8")));
  }
  return all;
};

const hasGuard = (route: ParsedRoute, guards: string[]) =>
  guards.some(
    (g) =>
      new RegExp(`\\b${g}\\b`).test(route.chain) ||
      route.routerLevelGuards.includes(g)
  );

/* ------------------------------------------------ (a) mọi route phải có guard hoặc được khai báo */

test("guard-matrix: mọi route đều có guard danh tính HOẶC nằm trong allowlist công khai", async () => {
  const routes = await loadAllRoutes();
  assert.ok(routes.length > 0, "không parse được route nào — regex hỏng?");

  const unguarded = routes
    .filter((r) => !hasGuard(r, IDENTITY_GUARDS))
    .filter((r) => !hasGuard(r, SOFT_GUARDS))
    .filter((r) => !(r.key in PUBLIC_ROUTES));

  assert.deepEqual(
    unguarded.map((r) => r.key),
    [],
    `Route KHÔNG có guard và KHÔNG được khai báo công khai.\n` +
      `Nếu route này thật sự phải công khai, thêm vào PUBLIC_ROUTES kèm lý do —\n` +
      `đó là một quyết định bảo mật, phải hiện ra trong diff của PR:\n` +
      unguarded.map((r) => `  '${r.key}': "lý do...",`).join("\n")
  );
});

// Chiều ngược lại: allowlist bị "mốc" cũng nguy hiểm — một entry trỏ tới route đã đổi tên/đã xoá sẽ
// im lặng mất tác dụng, và người đọc tưởng nó vẫn đang che một route nào đó.
test("guard-matrix: allowlist không có entry thừa (route đã đổi tên/đã xoá)", async () => {
  const routes = await loadAllRoutes();
  const keys = new Set(routes.map((r) => r.key));
  const stale = Object.keys(PUBLIC_ROUTES).filter((k) => !keys.has(k));
  assert.deepEqual(stale, [], `entry allowlist không còn khớp route nào:\n${stale.join("\n")}`);
});

test("guard-matrix: mọi entry allowlist đều có lý do không rỗng", () => {
  const empty = Object.entries(PUBLIC_ROUTES)
    .filter(([, reason]) => !reason || reason.trim().length < 10)
    .map(([k]) => k);
  assert.deepEqual(empty, [], `entry thiếu lý do (hoặc lý do quá ngắn):\n${empty.join("\n")}`);
});

/* --------------------------------- (b) route đã auth thì schema không được nhận danh tính từ client */

/**
 * Field danh tính KHÔNG được xuất hiện trong `body`/`query` của route đã có guard.
 *
 * `params` KHÔNG bị cấm: ở đó `userId` là địa chỉ tài nguyên (`/collections/:userId`) và đã được
 * `requireSelfOnParam`/`requireSelfOrRole` đối chiếu với `req.user`. Còn trong `body`/`query` thì
 * nó luôn là "tôi tự khai tôi là ai" — chính xác lớp lỗi (b).
 */
const IDENTITY_FIELDS = ["userId", "authorId", "fromUser", "senderId"];

/**
 * NỢ KỸ THUẬT ĐÃ TRIAGE — route đã có guard nhưng schema vẫn nhận danh tính từ client.
 *
 * Danh sách này KHÔNG phải chỗ để làm ngơ: nó tồn tại để test chặn được MỌI trường hợp MỚI trong
 * khi các trường hợp cũ được xử lý theo lô. Mỗi entry ghi rõ mức độ và vì sao.
 *
 * Ba nhóm, khác nhau về mức nguy hiểm:
 *
 *   [THEATRE] Route ĐÃ có `requireRole` đứng trước, nhưng controller kiểm role LẦN NỮA dựa trên
 *   `userId` do client gửi. Hiện KHÔNG khai thác được (guard route chạy trước và là biên thật),
 *   nhưng nguy hiểm ở chỗ nó TRÔNG như một lớp kiểm quyền: ai đó gỡ `requireRole` khỏi route sẽ
 *   tưởng controller vẫn còn kiểm — trong khi thứ nó kiểm là role của người mà KẺ GỌI chỉ định.
 *   Kèm theo là 1 query DB thừa mỗi request.
 *
 *   [EXPLOITABLE] Danh tính client tự khai là biên DUY NHẤT -> khai thác được ngay hôm nay.
 *
 *   [BENIGN] `userId` ở đây không mang nghĩa danh tính.
 */
const IDENTITY_PAYLOAD_DEBT: Record<string, string> = {
  // ---- [EXPLOITABLE] ----
  // (trống — cả 3 mục đã vá ở bước 9: 2 route hội thoại + sendReport)


  // ---- [THEATRE] ----
  // (trống) — 5 mục dọn ở bước 10 (đổi sang `assertRole(req.user, ...)`), mục thứ 6
  // (`updatePostVisibility`) hoá ra là bug chức năng chứ không phải theatre, đã xử lý riêng:
  // chính sách giờ là "chủ sở hữu HOẶC admin/mod", cả hai vế xét trên `req.user`.

  // ---- [BENIGN] ----
  "user.route.ts GET USERS_TO_TAG -> getUsersToTagQuerySchema.query.userId":
    "[BENIGN] chỉ dùng như cờ 'đã đăng nhập chưa' rồi bỏ; protectRoute đã đảm nhiệm việc đó",
  "message.route.ts POST FAKE_CONVERSATIONS -> handleFakeConversationsSchema.body.userId":
    "[BENIGN] tool seed dữ liệu dev, không phải đường dùng thật",
  "util.route.ts POST UTIL_PATH.UPLOAD -> uploadSchema.query.userId":
    "[BENIGN] chỉ là tên thư mục tạm, đã qua validateUploadUserId; danh tính thật cho public_id lấy từ req.user (util.route.ts:66)",
};

const loadValidators = async (): Promise<Record<string, any>> => {
  const files = (await readdir(VALIDATOR_DIR)).filter((f) => f.endsWith(".validator.ts"));
  const merged: Record<string, any> = {};
  for (const f of files) {
    const mod = await import(`../validators/${f}`);
    Object.assign(merged, mod);
  }
  return merged;
};

test("guard-matrix: route đã có guard thì schema KHÔNG được khai báo danh tính trong body/query", async () => {
  const routes = await loadAllRoutes();
  const validators = await loadValidators();

  const violations: string[] = [];
  for (const route of routes) {
    if (!hasGuard(route, IDENTITY_GUARDS)) continue;

    const m = route.chain.match(/validate\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/);
    if (!m) continue;
    const schema = validators[m[1]];
    if (!schema) continue;

    for (const part of ["body", "query"] as const) {
      // `.shape` chỉ có trên ZodObject; schema dựng bằng union/passthrough vẫn là ZodObject nên
      // vẫn đọc được. Thiếu `shape` -> bỏ qua thay vì fail, để test không đoán mò kiểu schema.
      const shape = schema[part]?.shape;
      if (!shape) continue;
      for (const field of IDENTITY_FIELDS) {
        if (field in shape) {
          violations.push(`${route.key} -> ${m[1]}.${part}.${field}`);
        }
      }
    }
  }

  const undeclared = violations.filter((v) => !(v in IDENTITY_PAYLOAD_DEBT));
  assert.deepEqual(
    undeclared,
    [],
    `Route đã xác thực nhưng schema vẫn nhận danh tính từ client.\n` +
      `Danh tính phải lấy từ req.user (JWT), không phải từ payload — đây đúng lớp lỗi đã tạo ra\n` +
      `V2 (mạo danh đăng bài) và V4 (ép user khác follow):\n` +
      undeclared.map((v) => `  ${v}`).join("\n")
  );
});

// Nợ chỉ được PHÉP GIẢM. Entry không còn khớp vi phạm nào nghĩa là chỗ đó đã sửa xong — phải xoá
// khỏi danh sách, nếu không lần sau lỗi tái xuất hiện ở đúng chỗ đó sẽ được che im lặng.
test("guard-matrix: danh sách nợ không có entry thừa (đã sửa thì phải xoá khỏi danh sách)", async () => {
  const routes = await loadAllRoutes();
  const validators = await loadValidators();
  const current = new Set<string>();

  for (const route of routes) {
    if (!hasGuard(route, IDENTITY_GUARDS)) continue;
    const m = route.chain.match(/validate\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/);
    if (!m) continue;
    const schema = validators[m[1]];
    if (!schema) continue;
    for (const part of ["body", "query"] as const) {
      const shape = schema[part]?.shape;
      if (!shape) continue;
      for (const field of IDENTITY_FIELDS) {
        if (field in shape) current.add(`${route.key} -> ${m[1]}.${part}.${field}`);
      }
    }
  }

  const stale = Object.keys(IDENTITY_PAYLOAD_DEBT).filter((k) => !current.has(k));
  assert.deepEqual(stale, [], `entry nợ đã được sửa, xoá khỏi IDENTITY_PAYLOAD_DEBT:\n${stale.join("\n")}`);
});

test("guard-matrix: mọi entry nợ phải gắn nhãn mức độ", () => {
  const bad = Object.entries(IDENTITY_PAYLOAD_DEBT)
    .filter(([, note]) => !/^\[(EXPLOITABLE|THEATRE|BENIGN)\]/.test(note))
    .map(([k]) => k);
  assert.deepEqual(bad, [], `entry nợ thiếu nhãn [EXPLOITABLE]/[THEATRE]/[BENIGN]:\n${bad.join("\n")}`);
});

/* ------------------------------------------------------------------ báo cáo */

// Không assert gì — in bảng tổng quan để mỗi lần chạy test đều thấy được bề mặt công khai hiện tại
// đang là bao nhiêu, thay vì phải tự đi đếm.
test("guard-matrix: tổng quan bề mặt API (báo cáo, không assert)", async () => {
  const routes = await loadAllRoutes();
  const guarded = routes.filter((r) => hasGuard(r, IDENTITY_GUARDS)).length;
  const soft = routes.filter(
    (r) => !hasGuard(r, IDENTITY_GUARDS) && hasGuard(r, SOFT_GUARDS)
  ).length;
  const publicDeclared = routes.filter(
    (r) =>
      !hasGuard(r, IDENTITY_GUARDS) &&
      !hasGuard(r, SOFT_GUARDS) &&
      r.key in PUBLIC_ROUTES
  ).length;

  console.log(
    `\n  [guard-matrix] ${routes.length} route: ` +
      `${guarded} có guard danh tính, ${soft} optionalAuth, ${publicDeclared} công khai đã khai báo\n`
  );
  assert.equal(guarded + soft + publicDeclared, routes.length);
});

/* ------------------------------------------------- (d) phân quyền, không chỉ xác thực */

test("guard-matrix: route quản trị / chính-chủ đều còn nguyên guard phân quyền", async () => {
  const routes = await loadAllRoutes();
  const byKey = new Map(routes.map((r) => [r.key, r]));

  const missing: string[] = [];
  for (const [key, reason] of Object.entries(ROLE_GUARDED_ROUTES)) {
    const route = byKey.get(key);
    if (!route) {
      missing.push(`${key} — route không còn tồn tại (đổi tên? xoá? cập nhật bảng)`);
      continue;
    }
    if (!AUTHZ_GUARDS.some((g) => new RegExp(`\\b${g}\\(`).test(route.chain))) {
      missing.push(`${key} — MẤT guard phân quyền (${reason})`);
    }
  }

  assert.deepEqual(
    missing,
    [],
    `Route khai báo cần phân quyền nhưng không còn guard nào:\n${missing.map((m) => "  " + m).join("\n")}`
  );
});
