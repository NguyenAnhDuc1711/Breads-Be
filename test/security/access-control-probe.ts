import "dotenv/config";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import { API_PREFIX } from "../../src/Breads-Shared/APIConfig.ts";
import { Constants } from "../../src/Breads-Shared/Constants/index.ts";
import PostConstants from "../../src/Breads-Shared/Constants/PostConstants.ts";

const BASE_URL = (process.env.PROBE_BASE_URL || "http://localhost:8080").replace(/\/$/, "");
const API = `${BASE_URL}${API_PREFIX}`;
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017";
const RUN_ID = Date.now();
const TAG = `probe-${RUN_ID}`;

const isLocalMongo = /localhost|127\.0\.0\.1/.test(MONGO_URI);
if (!isLocalMongo && process.env.PROBE_ALLOW_REMOTE !== "1") {
  console.error(
    `\n  ✗ TỪ CHỐI CHẠY: MONGO_URI không trỏ localhost.\n` +
      `    Probe này GHI dữ liệu (tạo user, đổi mật khẩu, xoá post).\n` +
      `    Nếu thực sự muốn: PROBE_ALLOW_REMOTE=1 npm run security:probe\n`
  );
  process.exit(1);
}

type Res = { status: number; body: any; raw: string; setCookie: string[] };

const http = async (
  method: string,
  url: string,
  opts: { body?: any; token?: string; cookie?: string } = {}
): Promise<Res> => {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  if (opts.cookie) headers["Cookie"] = opts.cookie;

  const res = await fetch(url, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 429) throttledResponses++;
  const raw = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  return {
    status: res.status,
    body,
    raw: raw.slice(0, 400),
    setCookie: (res.headers as any).getSetCookie?.() ?? [],
  };
};

const socketEmitWithAck = async (
  event: string,
  payload: any,
  opts: { token?: string; timeoutMs?: number } = {}
): Promise<{ ok: boolean; data: any; note: string }> => {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const url = (qs: string) => `${BASE_URL}/socket/?EIO=4&transport=polling&${qs}`;
  try {
    const hs = await fetch(url("t=" + Date.now()));
    const hsText = await hs.text();
    const sid = JSON.parse(hsText.slice(hsText.indexOf("{"), hsText.indexOf("}") + 1)).sid;

    const connectFrame = opts.token ? `40${JSON.stringify({ token: opts.token })}` : "40";
    await fetch(url(`sid=${sid}&t=${Date.now()}`), { method: "POST", body: connectFrame });
    await fetch(url(`sid=${sid}&t=${Date.now()}`));

    const ackId = 7;
    await fetch(url(`sid=${sid}&t=${Date.now()}`), {
      method: "POST",
      body: `42${ackId}${JSON.stringify([event, payload])}`,
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const poll = await fetch(url(`sid=${sid}&t=${Date.now()}`));
      const text = await poll.text();
      for (const frame of text.split("\x1e")) {
        if (frame.startsWith(`43${ackId}`)) {
          return { ok: true, data: JSON.parse(frame.slice(`43${ackId}`.length)), note: "ack nhận được" };
        }
      }
    }
    return { ok: false, data: null, note: "hết thời gian chờ ack" };
  } catch (err: any) {
    return { ok: false, data: null, note: `lỗi transport: ${err?.message}` };
  }
};

const oid = () => new mongoose.Types.ObjectId();

const F = {
  victimId: oid(),
  attackerId: oid(),
  bystanderId: oid(),
  victimPostId: oid(),
  victimSavedPostId: oid(),
  surveyOptionId: oid(),
  attackerForgedPostId: oid(),
  attackerOwnPostId: oid(),
  adminId: oid(),
  offlineId: oid(),
  chatMemberId: oid(),
  moderatorId: oid(),
  moderatedPostId: oid(),
  privateConversationId: oid(),
  privateMessageId: oid(),
  victimEmail: `${TAG}-victim@breads.local`,
  attackerEmail: `${TAG}-attacker@breads.local`,
  adminEmail: `${TAG}-admin@breads.local`,
  adminPassword: "AdminPass123",
  offlineEmail: `${TAG}-offline@breads.local`,
  offlinePassword: "OfflinePass123",
  chatMemberEmail: `${TAG}-chatmember@breads.local`,
  chatMemberPassword: "ChatMemberPass123",
  moderatorEmail: `${TAG}-moderator@breads.local`,
  moderatorPassword: "ModeratorPass123",
  victimPassword: "VictimPass123",
  attackerPassword: "AttackerPass123",
  newPasswordSetByAttacker: `Pwned-${RUN_ID}`,
};

const db = () => mongoose.connection.db!;

const seed = async () => {
  const hash = (pw: string) => bcrypt.hash(pw, 10);
  const now = new Date();

  await db().collection("users").insertMany([
    {
      _id: F.victimId, name: "Probe Victim", username: `${TAG}-victim`,
      email: F.victimEmail, password: await hash(F.victimPassword),
      role: Constants.USER_ROLE.USER, status: Constants.USER_STATUS.ACTIVE,
      followersCount: 0, followingCount: 0, bio: TAG, links: [], catesCare: [],
      createdAt: now, updatedAt: now,
    },
    {
      _id: F.attackerId, name: "Probe Attacker", username: `${TAG}-attacker`,
      email: F.attackerEmail, password: await hash(F.attackerPassword),
      role: Constants.USER_ROLE.USER, status: Constants.USER_STATUS.ACTIVE,
      followersCount: 0, followingCount: 0, bio: TAG, links: [], catesCare: [],
      createdAt: now, updatedAt: now,
    },
    {
      _id: F.adminId, name: "Probe Admin", username: `${TAG}-admin`,
      email: F.adminEmail, password: await hash(F.adminPassword),
      role: Constants.USER_ROLE.ADMIN, status: Constants.USER_STATUS.ACTIVE,
      followersCount: 0, followingCount: 0, bio: TAG, links: [], catesCare: [],
      createdAt: now, updatedAt: now,
    },
    {
      _id: F.moderatorId, name: "Probe Moderator", username: `${TAG}-moderator`,
      email: F.moderatorEmail, password: await hash(F.moderatorPassword),
      role: Constants.USER_ROLE.MODERATOR, status: Constants.USER_STATUS.ACTIVE,
      followersCount: 0, followingCount: 0, bio: TAG, links: [], catesCare: [],
      createdAt: now, updatedAt: now,
    },
    {
      _id: F.chatMemberId, name: "Probe ChatMember", username: `${TAG}-chatmember`,
      email: F.chatMemberEmail, password: await hash(F.chatMemberPassword),
      role: Constants.USER_ROLE.USER, status: Constants.USER_STATUS.ACTIVE,
      followersCount: 0, followingCount: 0, bio: TAG, links: [], catesCare: [],
      createdAt: now, updatedAt: now,
    },
    {
      _id: F.offlineId, name: "Probe Offline", username: `${TAG}-offline`,
      email: F.offlineEmail, password: await hash(F.offlinePassword),
      role: Constants.USER_ROLE.USER, status: Constants.USER_STATUS.INACTIVE,
      followersCount: 0, followingCount: 0, bio: TAG, links: [], catesCare: [],
      createdAt: now, updatedAt: now,
    },
    {
      _id: F.bystanderId, name: "Probe Bystander", username: `${TAG}-bystander`,
      email: `${TAG}-bystander@breads.local`, password: await hash("Bystander123"),
      role: Constants.USER_ROLE.USER, status: Constants.USER_STATUS.ACTIVE,
      followersCount: 0, followingCount: 0, bio: TAG, links: [], catesCare: [],
      createdAt: now, updatedAt: now,
    },
  ] as any);

  await db().collection("posts").insertMany([
    {
      _id: F.victimPostId, authorId: F.victimId, content: `${TAG} bài của nạn nhân`,
      media: [], type: PostConstants.ACTIONS.CREATE,
      status: Constants.POST_STATUS.PUBLIC, visibility: Constants.POST_VISIBILITY.PUBLIC,
      likesCount: 0, repliesCount: 0, engagementScore: 0,
      survey: [F.surveyOptionId], usersTag: [], links: [], files: [], categories: [],
      createdAt: now, updatedAt: now,
    },
    {
      _id: F.moderatedPostId, authorId: F.victimId, content: `${TAG} bài bị kiểm duyệt`,
      media: [], type: PostConstants.ACTIONS.CREATE,
      status: Constants.POST_STATUS.PUBLIC, visibility: Constants.POST_VISIBILITY.PUBLIC,
      likesCount: 0, repliesCount: 0, engagementScore: 0,
      survey: [], usersTag: [], links: [], files: [], categories: [],
      createdAt: now, updatedAt: now,
    },
    {
      _id: F.victimSavedPostId, authorId: F.bystanderId, content: `${TAG} bài đã lưu`,
      media: [], type: PostConstants.ACTIONS.CREATE,
      status: Constants.POST_STATUS.PUBLIC, visibility: Constants.POST_VISIBILITY.PUBLIC,
      likesCount: 0, repliesCount: 0, engagementScore: 0,
      survey: [], usersTag: [], links: [], files: [], categories: [],
      createdAt: now, updatedAt: now,
    },
  ] as any);

  await db().collection("conversations").insertOne({
    _id: F.privateConversationId,
    participants: [F.chatMemberId, F.bystanderId],
    msgIds: [F.privateMessageId],
    lastMsgId: F.privateMessageId,
    theme: "default", emoji: ":thumbsup:",
    createdAt: now, updatedAt: now,
  } as any);
  await db().collection("messages").insertOne({
    _id: F.privateMessageId,
    conversationId: F.privateConversationId,
    sender: F.chatMemberId,
    content: `${TAG} BÍ MẬT RIÊNG TƯ`,
    media: [], reacts: [], usersSeen: [], isRetrieve: false, type: "text",
    createdAt: now, updatedAt: now,
  } as any);

  await db().collection("surveyoptions").insertOne({
    _id: F.surveyOptionId, placeholder: "A", value: `${TAG}-option`, usersId: [],
  } as any);

  await db().collection("savedposts").insertOne({
    _id: oid(), userId: F.victimId, postId: F.victimSavedPostId, createdAt: now, updatedAt: now,
  } as any);
};

const cleanup = async () => {
  const userIds = [F.victimId, F.attackerId, F.bystanderId, F.adminId, F.offlineId, F.chatMemberId, F.moderatorId];
  const postIds = [F.victimPostId, F.victimSavedPostId, F.attackerForgedPostId, F.attackerOwnPostId, F.moderatedPostId];
  await db().collection("users").deleteMany({ _id: { $in: userIds } } as any);
  await db().collection("posts").deleteMany({
    $or: [{ _id: { $in: postIds } }, { authorId: { $in: userIds } }],
  } as any);
  await db().collection("surveyoptions").deleteMany({ _id: F.surveyOptionId } as any);
  await db().collection("savedposts").deleteMany({
    $or: [{ userId: { $in: userIds } }, { postId: { $in: postIds } }],
  } as any);
  await db().collection("follows").deleteMany({
    $or: [{ followerId: { $in: userIds } }, { followeeId: { $in: userIds } }],
  } as any);
  await db().collection("likes").deleteMany({ userId: { $in: userIds } } as any);
  await db().collection("conversations").deleteMany({
    $or: [{ _id: F.privateConversationId }, { participants: { $in: userIds } }],
  } as any);
  await db().collection("messages").deleteMany({
    $or: [{ conversationId: F.privateConversationId }, { sender: { $in: userIds } }],
  } as any);
  await db().collection("reports").deleteMany({ userId: { $in: userIds } } as any);
  await db().collection("refreshtokens").deleteMany({ userId: { $in: userIds } } as any);
  await db().collection("notifications").deleteMany({ fromUser: { $in: userIds } } as any);
  await db().collection("followsuggestions").deleteMany({ userId: { $in: userIds } } as any);
};

type Outcome = {
  id: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM";
  title: string;
  target: string;
  status: number | string;
  vulnerable: boolean | null;
  detail: string;
};

const login = async (email: string, password: string) =>
  http("POST", `${API}/users/sessions`, { body: { email, password } });

let throttledResponses = 0;

const tokenCache = new Map<string, string>();

const loginFailNote = (who: string) =>
  throttledResponses > 0
    ? `KHÔNG kết luận được: bị rate-limit (${throttledResponses} phản hồi 429). Đợi 60s rồi chạy lại.`
    : `không login được ${who}`;

const loginOnce = async (email: string, password: string): Promise<string | null> => {
  const cached = tokenCache.get(email);
  if (cached) return cached;
  const res = await login(email, password);
  if (res.status === 429) throttledResponses++;
  const token = res.body?.metadata?.accessToken;
  if (token) tokenCache.set(email, token);
  return token ?? null;
};

const probes: { id: string; severity: Outcome["severity"]; title: string; target: string; run: () => Promise<Omit<Outcome, "id" | "severity" | "title" | "target">> }[] = [
  {
    id: "V8",
    severity: "MEDIUM",
    title: "Email → userId không cần đăng nhập (nguyên liệu cho V1)",
    target: "POST /users/id-lookup",
    run: async () => {
      const r = await http("POST", `${API}/users/id-lookup`, { body: { userEmail: F.victimEmail, email: F.victimEmail } });
      const leaked = JSON.stringify(r.body ?? "").includes(String(F.victimId));
      return {
        status: r.status,
        vulnerable: r.status === 200 && leaked,
        detail: leaked ? `trả về userId của nạn nhân (${F.victimId})` : `không lộ userId — ${r.raw.slice(0, 120)}`,
      };
    },
  },
  {
    id: "V1",
    severity: "CRITICAL",
    title: "Chiếm tài khoản: đổi mật khẩu người khác KHÔNG cần đăng nhập",
    target: "PUT /users/:id/password",
    run: async () => {
      const r = await http("PUT", `${API}/users/${F.victimId}/password`, {
        body: { currentPW: "", newPW: F.newPasswordSetByAttacker, forgotPW: true },
      });
      if (r.status !== 200) {
        return { status: r.status, vulnerable: false, detail: `bị chặn — ${r.body?.message ?? r.raw.slice(0, 120)}` };
      }
      const takeover = await login(F.victimEmail, F.newPasswordSetByAttacker);
      return {
        status: r.status,
        vulnerable: takeover.status === 200,
        detail:
          takeover.status === 200
            ? `ĐÃ CHIẾM TÀI KHOẢN — login bằng mật khẩu attacker đặt trả 200 + accessToken`
            : `đổi được mật khẩu (200) nhưng login sau đó trả ${takeover.status}`,
      };
    },
  },
  {
    id: "V2a",
    severity: "CRITICAL",
    title: "Mạo danh đăng bài dưới tên người khác (không đăng nhập)",
    target: "POST /posts",
    run: async () => {
      const r = await http("POST", `${API}/posts?action=create`, {
        body: {
          _id: F.attackerForgedPostId, authorId: F.victimId,
          content: `${TAG} bài giả mạo do probe tạo`, media: [], survey: [],
          type: PostConstants.ACTIONS.CREATE, usersTag: [], links: [], files: [],
        },
      });
      const stored = await db().collection("posts").findOne({ _id: F.attackerForgedPostId } as any);
      return {
        status: r.status,
        vulnerable: !!stored && String(stored.authorId) === String(F.victimId),
        detail: stored
          ? `post đã ghi vào DB với authorId = nạn nhân (${F.victimId})`
          : `không tạo được — ${r.body?.message ?? r.raw.slice(0, 120)}`,
      };
    },
  },
  {
    id: "V5",
    severity: "MEDIUM",
    title: "Nhồi phiếu khảo sát dưới danh nghĩa người khác",
    target: "POST /posts/:id/survey-ticks",
    run: async () => {
      const r = await http("POST", `${API}/posts/${F.victimPostId}/survey-ticks`, {
        body: { optionId: F.surveyOptionId, userId: F.bystanderId, isAdd: true },
      });
      const opt = await db().collection("surveyoptions").findOne({ _id: F.surveyOptionId } as any);
      const ticked = (opt?.usersId ?? []).some((u: any) => String(u) === String(F.bystanderId));
      return {
        status: r.status,
        vulnerable: ticked,
        detail: ticked
          ? `phiếu đã ghi cho bystander (${F.bystanderId}) dù không ai đăng nhập`
          : `không ghi được — ${r.body?.message ?? r.raw.slice(0, 120)}`,
      };
    },
  },
  {
    id: "V2b",
    severity: "CRITICAL",
    title: "Sửa nội dung bài của người khác (không đăng nhập)",
    target: "PUT /posts/:id",
    run: async () => {
      const marker = `${TAG} NỘI DUNG BỊ SỬA BỞI PROBE`;
      const r = await http("PUT", `${API}/posts/${F.victimPostId}`, {
        body: { _id: String(F.victimPostId), userId: String(F.victimId), content: marker },
      });
      const post = await db().collection("posts").findOne({ _id: F.victimPostId } as any);
      return {
        status: r.status,
        vulnerable: post?.content === marker,
        detail:
          post?.content === marker
            ? `nội dung bài của nạn nhân đã bị ghi đè`
            : `không sửa được — ${r.body?.message ?? r.raw.slice(0, 120)}`,
      };
    },
  },
  {
    id: "V3a",
    severity: "HIGH",
    title: "Đọc collection (bài đã lưu) của người khác",
    target: "GET /collections/:userId",
    run: async () => {
      const r = await http("GET", `${API}/collections/${F.victimId}`);
      const leaked = JSON.stringify(r.body ?? "").includes(String(F.victimSavedPostId));
      return {
        status: r.status,
        vulnerable: r.status === 200 && leaked,
        detail: leaked ? `lộ danh sách bài đã lưu của nạn nhân` : `không lộ — ${r.raw.slice(0, 120)}`,
      };
    },
  },
  {
    id: "V3b",
    severity: "HIGH",
    title: "Xoá mục trong collection của người khác",
    target: "DELETE /collections/:userId/items/:postId",
    run: async () => {
      const r = await http("DELETE", `${API}/collections/${F.victimId}/items/${F.victimSavedPostId}`);
      const left = await db().collection("savedposts").countDocuments({
        userId: F.victimId, postId: F.victimSavedPostId,
      } as any);
      return {
        status: r.status,
        vulnerable: left === 0,
        detail: left === 0 ? `bản ghi saved của nạn nhân đã bị xoá` : `không xoá được — ${r.raw.slice(0, 120)}`,
      };
    },
  },
  {
    id: "V4",
    severity: "HIGH",
    title: "Ép user khác follow (đã đăng nhập bằng tài khoản attacker)",
    target: "PUT /users/follow",
    run: async () => {
      const auth = await login(F.attackerEmail, F.attackerPassword);
      const token = auth.body?.metadata?.accessToken;
      if (!token) return { status: auth.status, vulnerable: null, detail: "không login được attacker — bỏ qua" };

      const r = await http("PUT", `${API}/users/follow`, {
        token,
        body: { userId: String(F.victimId), userFlId: String(F.bystanderId) },
      });
      const forced = await db().collection("follows").countDocuments({
        followerId: F.victimId, followeeId: F.bystanderId,
      } as any);
      return {
        status: r.status,
        vulnerable: forced > 0,
        detail: forced > 0
          ? `attacker đã ép NẠN NHÂN follow bystander (bản ghi Follow tồn tại)`
          : `không ép được — ${r.body?.message ?? r.raw.slice(0, 120)}`,
      };
    },
  },
  {
    id: "V9",
    severity: "HIGH",
    title: "User bị BANNED vẫn đăng nhập và gọi API được",
    target: "POST /users/sessions",
    run: async () => {
      await db().collection("users").updateOne(
        { _id: F.bystanderId } as any,
        { $set: { status: Constants.USER_STATUS.BANNED, statusReason: TAG } }
      );
      const auth = await login(`${TAG}-bystander@breads.local`, "Bystander123");
      const token = auth.body?.metadata?.accessToken;
      if (!token) {
        return {
          status: auth.status,
          vulnerable: false,
          detail: `login bị chặn (${auth.status}) — ${auth.body?.message ?? auth.raw.slice(0, 120)}`,
        };
      }
      const me = await http("GET", `${API}/users/me`, { token });
      return {
        status: auth.status,
        vulnerable: me.status === 200,
        detail: me.status === 200
          ? `tài khoản BANNED vẫn login (200) và gọi GET /users/me thành công (200)`
          : `login được nhưng /me trả ${me.status}`,
      };
    },
  },
  {
    id: "V6",
    severity: "HIGH",
    title: "Socket ẩn danh lấy được toàn bộ báo cáo analytics",
    target: "WS /socket → /analytics/get-user-active-in-date-range",
    run: async () => {
      const to = new Date();
      const from = new Date(to.getTime() - 7 * 86400_000);
      const r = await socketEmitWithAck("/analytics/get-user-active-in-date-range", {
        dateRange: [from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)],
      });
      const leaked = r.ok && r.data?.[0] && !r.data[0].error;
      return {
        status: r.ok ? "ack" : "no-ack",
        vulnerable: !!leaked,
        detail: leaked
          ? `socket KHÔNG xác thực nhận được payload báo cáo (${JSON.stringify(r.data).slice(0, 140)}…)`
          : `bị chặn — ${r.ok ? JSON.stringify(r.data?.[0]) : r.note}`,
      };
    },
  },
  {
    id: "V2c",
    severity: "CRITICAL",
    title: "Xoá bài của người khác (không đăng nhập)",
    target: "DELETE /posts/:id",
    run: async () => {
      const r = await http("DELETE", `${API}/posts/${F.victimPostId}?userId=${F.victimId}`);
      const post = await db().collection("posts").findOne({ _id: F.victimPostId } as any);
      return {
        status: r.status,
        vulnerable: post?.status === Constants.POST_STATUS.DELETED,
        detail: post?.status === Constants.POST_STATUS.DELETED
          ? `bài của nạn nhân đã bị chuyển sang trạng thái DELETED`
          : `không xoá được — ${r.body?.message ?? r.raw.slice(0, 120)}`,
      };
    },
  },
  {
    id: "V15",
    severity: "HIGH",
    title: "Đọc hội thoại riêng tư của 2 người khác (đã đăng nhập, không phải thành viên)",
    target: "POST /messages/conversations/lookup-by-users",
    run: async () => {
      const token = await loginOnce(F.attackerEmail, F.attackerPassword);
      if (!token) return { status: "no-token", vulnerable: null, detail: loginFailNote("attacker") };
      const r = await http("POST", `${API}/messages/conversations/lookup-by-users`, {
        token,
        body: { userId: String(F.chatMemberId), anotherId: String(F.bystanderId) },
      });
      const leaked = JSON.stringify(r.body ?? "").includes(String(F.privateConversationId));
      return {
        status: r.status,
        vulnerable: leaked,
        detail: leaked
          ? `lộ hội thoại riêng tư giữa 2 người khác (${F.privateConversationId})`
          : `không lộ — ${r.status} ${r.body?.message ?? ""}`,
      };
    },
  },
  {
    id: "V16",
    severity: "HIGH",
    title: "Đọc nội dung hội thoại mình KHÔNG tham gia (biết conversationId là đủ)",
    target: "GET /messages/conversations/:id  +  /media /files /links",
    run: async () => {
      const token = await loginOnce(F.attackerEmail, F.attackerPassword);
      if (!token) return { status: "no-token", vulnerable: null, detail: loginFailNote("attacker") };

      const base = `${API}/messages/conversations/${F.privateConversationId}`;
      const results = await Promise.all([
        http("GET", `${base}?conversationId=${F.privateConversationId}`, { token }),
        http("GET", `${base}/media`, { token }),
        http("GET", `${base}/files`, { token }),
        http("GET", `${base}/links`, { token }),
      ]);
      const served = results.filter((r) => r.status === 200);
      const leakedSecret = results.some((r) =>
        JSON.stringify(r.body ?? "").includes("BÍ MẬT RIÊNG TƯ")
      );
      return {
        status: results.map((r) => r.status).join("/"),
        vulnerable: served.length > 0,
        detail:
          served.length > 0
            ? `${served.length}/4 endpoint phục vụ dữ liệu hội thoại người khác${leakedSecret ? " (có cả nội dung tin nhắn)" : ""}`
            : `cả 4 endpoint đều bị chặn (${results.map((r) => r.status).join("/")})`,
      };
    },
  },
  {
    id: "V17",
    severity: "HIGH",
    title: "Tìm kiếm nội dung tin nhắn trong hội thoại người khác",
    target: "POST /messages/search",
    run: async () => {
      const token = await loginOnce(F.attackerEmail, F.attackerPassword);
      if (!token) return { status: "no-token", vulnerable: null, detail: loginFailNote("attacker") };
      const r = await http("POST", `${API}/messages/search`, {
        token,
        body: {
          value: "BÍ MẬT",
          conversationId: String(F.privateConversationId),
          page: 1,
          limit: 10,
        },
      });
      const leaked = JSON.stringify(r.body ?? "").includes("BÍ MẬT RIÊNG TƯ");
      return {
        status: r.status,
        vulnerable: r.status === 200 && leaked,
        detail: leaked
          ? "tìm được nội dung tin nhắn riêng tư của người khác"
          : `bị chặn — ${r.status} ${r.body?.message ?? ""}`,
      };
    },
  },
  {
    id: "V7",
    severity: "MEDIUM",
    title: "Mail relay: gửi mail tuỳ ý qua SMTP hệ thống",
    target: "POST /util/send-forgot-pw-mail",
    run: async () => {
      const r = await http("POST", `${API}/util/send-forgot-pw-mail`, {
        body: {
          from: "security@probe.invalid", to: F.victimEmail,
          subject: `${TAG} tiêu đề do kẻ tấn công đặt`,
          code: "AAAAAA0", url: "https://attacker.invalid/userId/AAAAAA0",
        },
      });
      return {
        status: r.status,
        vulnerable: r.status === 200,
        detail: r.status === 200
          ? `server nhận from/subject/url tuỳ ý và đã gửi mail`
          : `endpoint không còn tồn tại (${r.status}) — đúng như thiết kế sau bước 2`,
      };
    },
  },
];

type Regression = { id: string; title: string; run: () => Promise<{ pass: boolean; detail: string }> };

const RESET_CODE = "A1b2C3";

const seedResetCode = async (userId: string, code: string) => {
  const Redis = (await import("ioredis")).default;
  const redis = new Redis({
    host: process.env.REDIS_HOST || "localhost",
    port: Number(process.env.REDIS_PORT || 6379),
  });
  const codeHash = crypto.createHash("sha256").update(code.toUpperCase()).digest("hex");
  await redis.setex(`pw_reset_${userId}`, 900, JSON.stringify({ codeHash, attempts: 0 }));
  await redis.quit();
};

const resetAuthTierQuota = async () => {
  const Redis = (await import("ioredis")).default;
  const redis = new Redis({
    host: process.env.REDIS_HOST || "localhost",
    port: Number(process.env.REDIS_PORT || 6379),
  });
  const keys = await redis.keys("rl:sw:*");
  if (keys.length) await redis.del(...keys);
  await redis.quit();
};

const clearResetCode = async (userId: string) => {
  const Redis = (await import("ioredis")).default;
  const redis = new Redis({
    host: process.env.REDIS_HOST || "localhost",
    port: Number(process.env.REDIS_PORT || 6379),
  });
  await redis.del(`pw_reset_${userId}`);
  await redis.quit();
};

const regressions: Regression[] = [
  {
    id: "R1",
    title: "requests: email KHÔNG tồn tại vẫn trả 200 (không rò rỉ tài khoản nào có thật)",
    run: async () => {
      const r = await http("POST", `${API}/users/password-reset/requests`, {
        body: { email: `${TAG}-nobody@breads.local` },
      });
      return {
        pass: r.status === 200,
        detail: `status ${r.status} — ${r.body?.message ?? r.raw.slice(0, 80)}`,
      };
    },
  },
  {
    id: "R2",
    title: "confirm: mã SAI bị từ chối",
    run: async () => {
      await seedResetCode(String(F.victimId), RESET_CODE);
      const r = await http("POST", `${API}/users/password-reset/confirm`, {
        body: { userId: String(F.victimId), code: "ZZZZZZ", newPW: "should-not-apply" },
      });
      const stillOld = (await login(F.victimEmail, F.victimPassword)).status === 200;
      return {
        pass: r.status !== 200 && stillOld,
        detail: `confirm trả ${r.status}; mật khẩu cũ ${stillOld ? "còn nguyên" : "ĐÃ BỊ ĐỔI (sai!)"}`,
      };
    },
  },
  {
    id: "R3",
    title: "verify + confirm: mã ĐÚNG đổi được mật khẩu và đăng nhập được",
    run: async () => {
      await seedResetCode(String(F.victimId), RESET_CODE);
      const v = await http("POST", `${API}/users/password-reset/verify`, {
        body: { email: F.victimEmail, code: RESET_CODE },
      });
      const gotUserId = v.body?.metadata?.userId === String(F.victimId);

      const newPW = `Reset-${RUN_ID}`;
      const c = await http("POST", `${API}/users/password-reset/confirm`, {
        body: { userId: String(F.victimId), code: RESET_CODE, newPW },
      });
      const canLogin = (await login(F.victimEmail, newPW)).status === 200;
      return {
        pass: gotUserId && c.status === 200 && canLogin,
        detail: `verify trả userId đúng: ${gotUserId}; confirm ${c.status}; login bằng mật khẩu mới: ${canLogin}`,
      };
    },
  },
  {
    id: "R5",
    title: "createPost: tác giả lấy từ JWT — authorId client bịa trong body bị bỏ qua",
    run: async () => {
      const auth = await login(F.attackerEmail, F.attackerPassword);
      const token = auth.body?.metadata?.accessToken;
      if (!token) return { pass: false, detail: `không login được attacker (${auth.status})` };

      const r = await http("POST", `${API}/posts?action=create`, {
        token,
        body: {
          _id: String(F.attackerOwnPostId),
          authorId: String(F.victimId),
          content: `${TAG} bài hợp lệ của attacker`,
          media: [], survey: [], usersTag: [], links: [], files: [],
          type: PostConstants.ACTIONS.CREATE,
        },
      });
      const stored = await db().collection("posts").findOne({ _id: F.attackerOwnPostId } as any);
      const ownedByCaller = String(stored?.authorId) === String(F.attackerId);
      return {
        pass: r.status === 201 && ownedByCaller,
        detail: `status ${r.status}; authorId đã lưu = ${ownedByCaller ? "người gọi (đúng)" : String(stored?.authorId)}`,
      };
    },
  },
  {
    id: "R6",
    title: "updatePost/deletePost: CHỦ SỞ HỮU vẫn sửa và xoá được bài của mình",
    run: async () => {
      const token = await loginOnce(F.attackerEmail, F.attackerPassword);
      if (!token) return { pass: false, detail: loginFailNote("attacker") };

      const marker = `${TAG} nội dung đã sửa hợp lệ`;
      const upd = await http("PUT", `${API}/posts/${F.attackerOwnPostId}`, {
        token,
        body: { _id: String(F.attackerOwnPostId), content: marker },
      });
      const afterUpdate = await db().collection("posts").findOne({ _id: F.attackerOwnPostId } as any);
      const edited = afterUpdate?.content === marker;

      const del = await http("DELETE", `${API}/posts/${F.attackerOwnPostId}`, { token });
      const afterDelete = await db().collection("posts").findOne({ _id: F.attackerOwnPostId } as any);
      const deleted = afterDelete?.status === Constants.POST_STATUS.DELETED;

      return {
        pass: upd.status === 200 && edited && del.status === 200 && deleted,
        detail: `update ${upd.status} (nội dung đổi: ${edited}); delete ${del.status} (status DELETED: ${deleted})`,
      };
    },
  },
  {
    id: "R7",
    title: "updatePost/deletePost: người ĐÃ ĐĂNG NHẬP vẫn không đụng được bài người khác",
    run: async () => {
      const token = await loginOnce(F.attackerEmail, F.attackerPassword);
      if (!token) return { pass: false, detail: loginFailNote("attacker") };

      const before = await db().collection("posts").findOne({ _id: F.victimPostId } as any);
      const upd = await http("PUT", `${API}/posts/${F.victimPostId}`, {
        token,
        body: { _id: String(F.victimPostId), content: `${TAG} SỬA TRỘM` },
      });
      const del = await http("DELETE", `${API}/posts/${F.victimPostId}`, { token });
      const after = await db().collection("posts").findOne({ _id: F.victimPostId } as any);

      const untouched =
        after?.content === before?.content && after?.status !== Constants.POST_STATUS.DELETED;
      return {
        pass: upd.status !== 200 && del.status !== 200 && untouched,
        detail: `update ${upd.status}, delete ${del.status}; bài nạn nhân ${untouched ? "còn nguyên" : "ĐÃ BỊ ĐỔI (sai!)"}`,
      };
    },
  },
  {
    id: "R8",
    title: "collection: chủ sở hữu vẫn đọc / thêm / xoá được bài đã lưu của mình",
    run: async () => {
      const token = await loginOnce(F.attackerEmail, F.attackerPassword);
      if (!token) return { pass: false, detail: loginFailNote("attacker") };

      const add = await http("PATCH", `${API}/collections/${F.attackerId}/items`, {
        token,
        body: { postId: String(F.victimSavedPostId) },
      });
      const saved = await db().collection("savedposts").countDocuments({
        userId: F.attackerId, postId: F.victimSavedPostId,
      } as any);

      const read = await http("GET", `${API}/collections/${F.attackerId}`, { token });
      const listed = JSON.stringify(read.body ?? "").includes(String(F.victimSavedPostId));

      const del = await http(
        "DELETE",
        `${API}/collections/${F.attackerId}/items/${F.victimSavedPostId}`,
        { token }
      );
      const gone =
        (await db().collection("savedposts").countDocuments({
          userId: F.attackerId, postId: F.victimSavedPostId,
        } as any)) === 0;

      return {
        pass: [add.status, read.status, del.status].every((s) => s < 300) && saved === 1 && listed && gone,
        detail: `add ${add.status} (ghi: ${saved === 1}); read ${read.status} (thấy bài: ${listed}); delete ${del.status} (đã xoá: ${gone})`,
      };
    },
  },
  {
    id: "R9",
    title: "follow: bản ghi ghi cho NGƯỜI GỌI, không cho userId client bịa trong body",
    run: async () => {
      const token = await loginOnce(F.attackerEmail, F.attackerPassword);
      if (!token) return { pass: false, detail: loginFailNote("attacker") };

      const r = await http("PUT", `${API}/users/follow`, {
        token,
        body: { userId: String(F.bystanderId), userFlId: String(F.victimId) },
      });
      const correct = await db().collection("follows").countDocuments({
        followerId: F.attackerId, followeeId: F.victimId,
      } as any);
      const forged = await db().collection("follows").countDocuments({
        followerId: F.bystanderId, followeeId: F.victimId,
      } as any);
      return {
        pass: r.status === 200 && correct === 1 && forged === 0,
        detail: `status ${r.status}; follow(người gọi→victim)=${correct}, follow(userId bịa→victim)=${forged} (phải là 0)`,
      };
    },
  },
  {
    id: "R10",
    title: "analytics: socket của ADMIN vẫn lấy được báo cáo bình thường",
    run: async () => {
      const token = await loginOnce(F.adminEmail, F.adminPassword);
      if (!token) return { pass: false, detail: loginFailNote("admin") };

      const to = new Date();
      const from = new Date(to.getTime() - 7 * 86400_000);
      const r = await socketEmitWithAck(
        "/analytics/get-user-active-in-date-range",
        { dateRange: [from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)] },
        { token }
      );
      const data = r.data?.[0];
      const served = !!data && !data.error && Array.isArray(data.active);
      return {
        pass: served,
        detail: served
          ? `admin nhận đủ báo cáo (active: ${data.active.length} mốc ngày, có device/locale/os/event)`
          : `KHÔNG phục vụ được admin — ${r.ok ? JSON.stringify(data) : r.note}`,
      };
    },
  },
  {
    id: "R11",
    title: "analytics: khoảng ngày vượt trần bị chặn kể cả với ADMIN",
    run: async () => {
      const token = await loginOnce(F.adminEmail, F.adminPassword);
      if (!token) return { pass: false, detail: loginFailNote("admin") };

      const r = await socketEmitWithAck(
        "/analytics/get-user-active-in-date-range",
        { dateRange: ["2000-01-01", "2030-01-01"] },
        { token }
      );
      const data = r.data?.[0];
      const rejected = !!data?.error && !data.active;
      return {
        pass: rejected,
        detail: rejected
          ? `bị chặn đúng: ${data.error}`
          : `KHÔNG chặn — vẫn nạp cả collection vào RAM (${JSON.stringify(data).slice(0, 100)})`,
      };
    },
  },
  {
    id: "R19",
    title: "assertRole: đọc được role qua protectRoute THẬT (không chỉ qua req.user stub)",
    run: async () => {
      const token = await loginOnce(F.adminEmail, F.adminPassword);
      if (!token) return { pass: false, detail: loginFailNote("admin") };
      const r = await http("GET", `${API}/users/with-status?page=1&limit=1`, { token });
      return {
        pass: r.status === 200,
        detail: `ADMIN -> GET /users/with-status: ${r.status}${r.status !== 200 ? " (role không đọc được?)" : ""}`,
      };
    },
  },
  {
    id: "R20",
    title: "role trên route KHÔNG có requireRole: MODERATOR kiểm duyệt được, USER thường thì không",
    run: async () => {
      const modToken = await loginOnce(F.moderatorEmail, F.moderatorPassword);
      const userToken = await loginOnce(F.chatMemberEmail, F.chatMemberPassword);
      if (!modToken || !userToken) return { pass: false, detail: loginFailNote("mod/user") };

      const asMod = await http("PATCH", `${API}/posts/${F.moderatedPostId}/visibility`, {
        token: modToken,
        body: { visibility: Constants.POST_VISIBILITY.ONLY_ME },
      });
      const afterMod = await db().collection("posts").findOne({ _id: F.moderatedPostId } as any);
      const modApplied = afterMod?.visibility === Constants.POST_VISIBILITY.ONLY_ME;

      const asUser = await http("PATCH", `${API}/posts/${F.moderatedPostId}/visibility`, {
        token: userToken,
        body: { visibility: Constants.POST_VISIBILITY.PUBLIC },
      });
      const afterUser = await db().collection("posts").findOne({ _id: F.moderatedPostId } as any);
      const userBlocked = afterUser?.visibility === Constants.POST_VISIBILITY.ONLY_ME;

      return {
        pass: asMod.status === 200 && modApplied && asUser.status === 403 && userBlocked,
        detail: `MODERATOR ${asMod.status} (áp dụng: ${modApplied}); USER thường ${asUser.status} (bài giữ nguyên: ${userBlocked})`,
      };
    },
  },
  {
    id: "R12",
    title: "ban: token cấp TRƯỚC khi bị cấm cũng ngừng dùng được ngay",
    run: async () => {
      const token = await loginOnce(F.attackerEmail, F.attackerPassword);
      if (!token) return { pass: false, detail: loginFailNote("attacker") };

      const before = await http("GET", `${API}/users/me`, { token });

      await db().collection("users").updateOne(
        { _id: F.attackerId } as any,
        { $set: { status: Constants.USER_STATUS.BANNED, statusReason: TAG } }
      );

      const after = await http("GET", `${API}/users/me`, { token });
      const relogin = await login(F.attackerEmail, F.attackerPassword);
      return {
        pass: before.status === 200 && after.status === 403 && relogin.status === 403,
        detail: `/me trước khi cấm ${before.status}; sau khi cấm ${after.status} (code=${after.body?.code}); login lại ${relogin.status}`,
      };
    },
  },
  {
    id: "R13",
    title: "ban: user INACTIVE (offline) KHÔNG bị chặn nhầm",
    run: async () => {
      const auth = await login(F.offlineEmail, F.offlinePassword);
      const token = auth.body?.metadata?.accessToken;
      const me = token ? await http("GET", `${API}/users/me`, { token }) : null;
      return {
        pass: auth.status === 200 && me?.status === 200,
        detail: `login ${auth.status}; /me ${me?.status ?? "—"} (INACTIVE là trạng thái hiện diện, không phải kiểm duyệt)`,
      };
    },
  },
  {
    id: "R14",
    title: "ban: socket của tài khoản bị cấm không được gắn danh tính",
    run: async () => {
      const token = await loginOnce(F.adminEmail, F.adminPassword);
      if (!token) return { pass: false, detail: loginFailNote("admin") };

      await db().collection("users").updateOne(
        { _id: F.adminId } as any,
        { $set: { status: Constants.USER_STATUS.BANNED, statusReason: TAG } }
      );

      const to = new Date();
      const from = new Date(to.getTime() - 7 * 86400_000);
      const r = await socketEmitWithAck(
        "/analytics/get-user-active-in-date-range",
        { dateRange: [from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)] },
        { token }
      );
      const data = r.data?.[0];
      const blocked = !!data?.error && !data.active;
      return {
        pass: blocked,
        detail: blocked
          ? `socket của admin BỊ CẤM bị từ chối: ${data.error}`
          : `VẪN phục vụ được (${JSON.stringify(data).slice(0, 100)})`,
      };
    },
  },
  {
    id: "R15",
    title: "chat: THÀNH VIÊN hội thoại vẫn đọc và tìm kiếm bình thường",
    run: async () => {
      const token = await loginOnce(F.chatMemberEmail, F.chatMemberPassword);
      if (!token) return { pass: false, detail: loginFailNote("chatMember") };

      const base = `${API}/messages/conversations/${F.privateConversationId}`;
      const detail = await http(
        "GET",
        `${base}?conversationId=${F.privateConversationId}`,
        { token }
      );
      const media = await http("GET", `${base}/media`, { token });
      const search = await http("POST", `${API}/messages/search`, {
        token,
        body: { value: "BÍ MẬT", conversationId: String(F.privateConversationId), page: 1, limit: 10 },
      });
      const found = JSON.stringify(search.body ?? "").includes("BÍ MẬT RIÊNG TƯ");
      const lookup = await http("POST", `${API}/messages/conversations/lookup-by-users`, {
        token,
        body: { anotherId: String(F.bystanderId) },
      });
      const lookupOk = JSON.stringify(lookup.body ?? "").includes(String(F.privateConversationId));

      return {
        pass: detail.status === 200 && media.status === 200 && search.status === 200 && found && lookupOk,
        detail: `detail ${detail.status}; media ${media.status}; search ${search.status} (tìm thấy nội dung: ${found}); lookup-by-users ra đúng hội thoại: ${lookupOk}`,
      };
    },
  },
  {
    id: "R16",
    title: "report: bản ghi gắn cho NGƯỜI GỌI, không cho userId client bịa",
    run: async () => {
      const token = await loginOnce(F.chatMemberEmail, F.chatMemberPassword);
      if (!token) return { pass: false, detail: loginFailNote("chatMember") };

      const r = await http("POST", `${API}/reports`, {
        token,
        body: { userId: String(F.victimId), content: `${TAG} nội dung report` },
      });
      const mine = await db().collection("reports").countDocuments({ userId: F.chatMemberId } as any);
      const forged = await db().collection("reports").countDocuments({ userId: F.victimId } as any);
      return {
        pass: r.status < 300 && mine === 1 && forged === 0,
        detail: `status ${r.status}; report(người gọi)=${mine}, report(userId bịa)=${forged} (phải là 0)`,
      };
    },
  },
  {
    id: "R17",
    title: "visibility: CHỦ SỞ HỮU đổi được quyền riêng tư bài của mình (trước đây 403)",
    run: async () => {
      const token = await loginOnce(F.chatMemberEmail, F.chatMemberPassword);
      if (!token) return { pass: false, detail: loginFailNote("chatMember") };

      const ownPostId = new mongoose.Types.ObjectId();
      const created = await http("POST", `${API}/posts?action=create`, {
        token,
        body: {
          _id: String(ownPostId),
          content: `${TAG} bài để đổi visibility`,
          media: [], survey: [], usersTag: [], links: [], files: [],
          type: PostConstants.ACTIONS.CREATE,
        },
      });
      const r = await http("PATCH", `${API}/posts/${ownPostId}/visibility`, {
        token,
        body: { visibility: Constants.POST_VISIBILITY.ONLY_ME },
      });
      const stored = await db().collection("posts").findOne({ _id: ownPostId } as any);
      const applied = stored?.visibility === Constants.POST_VISIBILITY.ONLY_ME;
      await db().collection("posts").deleteOne({ _id: ownPostId } as any);
      return {
        pass: created.status === 201 && r.status === 200 && applied,
        detail: `create ${created.status}; visibility ${r.status}; đã áp dụng ONLY_ME: ${applied}`,
      };
    },
  },
  {
    id: "R18",
    title: "visibility: người KHÔNG phải chủ sở hữu và không phải mod bị chặn",
    run: async () => {
      const token = await loginOnce(F.chatMemberEmail, F.chatMemberPassword);
      if (!token) return { pass: false, detail: loginFailNote("chatMember") };

      const before = await db().collection("posts").findOne({ _id: F.victimPostId } as any);
      const r = await http("PATCH", `${API}/posts/${F.victimPostId}/visibility`, {
        token,
        body: { visibility: Constants.POST_VISIBILITY.ONLY_ME },
      });
      const after = await db().collection("posts").findOne({ _id: F.victimPostId } as any);
      const untouched = after?.visibility === before?.visibility;
      return {
        pass: r.status === 403 && untouched,
        detail: `status ${r.status}; visibility bài nạn nhân ${untouched ? "còn nguyên" : "ĐÃ BỊ ĐỔI (sai!)"}`,
      };
    },
  },
  {
    id: "R4",
    title: "confirm: mã dùng một lần — tái sử dụng bị từ chối",
    run: async () => {
      const r = await http("POST", `${API}/users/password-reset/confirm`, {
        body: { userId: String(F.victimId), code: RESET_CODE, newPW: `Replay-${RUN_ID}` },
      });
      const replayWorked = (await login(F.victimEmail, `Replay-${RUN_ID}`)).status === 200;
      return {
        pass: r.status !== 200 && !replayWorked,
        detail: `replay trả ${r.status}; đăng nhập bằng mật khẩu replay: ${replayWorked ? "ĐƯỢC (sai!)" : "không"}`,
      };
    },
  },
];

const main = async () => {
  console.log(`\n  Access-control probe — run ${RUN_ID}`);
  console.log(`  target : ${BASE_URL}`);
  console.log(`  mongo  : ${MONGO_URI.replace(/\/\/[^@]*@/, "//<redacted>@")}\n`);

  try {
    const ping = await fetch(`${API}/posts?page=1&limit=1&filter[page]=for_you`);
    if (ping.status >= 500) throw new Error(`server trả ${ping.status}`);
  } catch (err: any) {
    console.error(`  ✗ Không kết nối được BE tại ${BASE_URL} — chạy \`npm run dev\` trước.\n    (${err?.message})\n`);
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  await seed();

  const results: Outcome[] = [];
  const regressionResults: { id: string; title: string; pass: boolean; detail: string }[] = [];
  try {
    for (const p of probes) {
      let outcome: Omit<Outcome, "id" | "severity" | "title" | "target">;
      try {
        await resetAuthTierQuota();
        outcome = await p.run();
      } catch (err: any) {
        outcome = { status: "error", vulnerable: null, detail: `probe lỗi: ${err?.message}` };
      }
      results.push({ id: p.id, severity: p.severity, title: p.title, target: p.target, ...outcome });
      const mark = outcome.vulnerable === null ? "–" : outcome.vulnerable ? "✗" : "✓";
      console.log(`  ${mark} ${p.id.padEnd(4)} ${String(outcome.status).padEnd(8)} ${p.title}`);
      console.log(`         ${p.target}\n         ${outcome.detail}\n`);
    }
    console.log("  ── regression: luồng quên mật khẩu server-side ──\n");
    for (const r of regressions) {
      let outcome: { pass: boolean; detail: string };
      try {
        await resetAuthTierQuota();
        outcome = await r.run();
      } catch (err: any) {
        outcome = { pass: false, detail: `lỗi: ${err?.message}` };
      }
      regressionResults.push({ id: r.id, title: r.title, ...outcome });
      console.log(`  ${outcome.pass ? "✓" : "✗"} ${r.id.padEnd(4)}          ${r.title}`);
      console.log(`         ${outcome.detail}\n`);
    }
  } finally {
    await clearResetCode(String(F.victimId)).catch(() => {});
    await cleanup();
    await mongoose.connection.close();
  }

  const vulnerable = results.filter((r) => r.vulnerable === true);
  const safe = results.filter((r) => r.vulnerable === false);
  const skipped = results.filter((r) => r.vulnerable === null);

  console.log("  ────────────────────────────────────────────────");
  console.log(`  KHAI THÁC THÀNH CÔNG : ${vulnerable.length}/${results.length - skipped.length}`);
  console.log(`  đã chặn              : ${safe.length}`);
  console.log(`  bỏ qua               : ${skipped.length}`);
  if (vulnerable.length) {
    const bySev = (s: string) => vulnerable.filter((v) => v.severity === s).map((v) => v.id);
    console.log(`  CRITICAL: ${bySev("CRITICAL").join(", ") || "—"}`);
    console.log(`  HIGH    : ${bySev("HIGH").join(", ") || "—"}`);
    console.log(`  MEDIUM  : ${bySev("MEDIUM").join(", ") || "—"}`);
  }
  const regressionFailed = regressionResults.filter((r) => !r.pass);
  console.log(`  regression luồng mới  : ${regressionResults.length - regressionFailed.length}/${regressionResults.length} pass`);
  if (throttledResponses > 0) {
    console.log(
      `\n  ⚠️  ${throttledResponses} phản hồi 429 trong lượt này — rate limiter đã can thiệp vào\n` +
        `      phép đo. Một lượt probe đầy đủ phát >100 request, sát trần globalTierLimiter\n` +
        `      (100 req/phút/IP, in-memory). Đợi 60s giữa 2 lần chạy; kết quả trên KHÔNG đáng tin.`
    );
  }
  console.log("  ────────────────────────────────────────────────\n");

  const outDir = path.resolve(import.meta.dirname, "../results");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}__access-control-probe.json`);
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      { runId: RUN_ID, baseUrl: BASE_URL, ranAt: new Date().toISOString(),
        summary: {
          total: results.length, vulnerable: vulnerable.length, safe: safe.length, skipped: skipped.length,
          regressionTotal: regressionResults.length, regressionFailed: regressionFailed.length,
        },
        results, regressions: regressionResults },
      null, 2
    )
  );
  console.log(`  → ${path.relative(process.cwd(), outFile)}\n`);

  process.exit(vulnerable.length || regressionFailed.length ? 1 : 0);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
