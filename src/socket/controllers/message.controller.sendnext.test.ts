import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import mongoose from "mongoose";
import Conversation from "../../api/models/conversation.model.js";
import Message from "../../api/models/message.model.js";
import User from "../../api/models/user.model.js";
import ConversationRead from "../../api/models/conversationRead.model.js";
import { messageSendLimiter } from "../middlewares/rateLimiter.js";
import MessageController from "./message.controller.js";
import { MESSAGE_PATH, Route } from "../../Breads-Shared/APIConfig.js";

const MONGO_PORT = 47_100 + (process.pid % 500);
const DB_NAME = "breads_sendnext_test";

let mongod: ChildProcess | null = null;
let dbPath = "";

const fakeSocket = (userId?: string) => ({
  id: "sk-1",
  user: userId ? { userId } : undefined,
});

const fakeIo = () => {
  const emits: any[] = [];
  return {
    emits,
    to(target: string) {
      return { emit: (p: any, d: any) => emits.push({ target, p, d }) };
    },
  };
};

const LEGACY_MEDIA = [
  { url: "https://legacy-cdn.example.com/uploads/old-photo-2023.png", type: "image" },
];
const CLIENT_INJECTED_MEDIA = [
  { url: "https://attacker.example.com/tracking-pixel.png", type: "image" },
];

let userA: any;
let userB: any;
let userC: any;
let convAC: any;
let convAB: any;
let convBC: any;
let msgInAC: any;

const seedUser = (name: string) =>
  User.create({
    name,
    username: `${name}-${Date.now()}`,
    email: `${name}-${Date.now()}@example.com`,
    password: "password123",
  });

before(async () => {
  dbPath = mkdtempSync(join(tmpdir(), "breads-sendnext-"));
  mongod = spawn(
    "mongod",
    [
      "--dbpath",
      dbPath,
      "--port",
      String(MONGO_PORT),
      "--bind_ip",
      "127.0.0.1",
      "--setParameter",
      "enableTestCommands=1",
    ],
    { stdio: "ignore" }
  );
  mongod.on("error", () => {
    /* lỗi spawn được báo qua timeout kết nối bên dưới, kèm hướng dẫn rõ ràng */
  });

  const uri = `mongodb://127.0.0.1:${MONGO_PORT}/${DB_NAME}`;
  const deadline = Date.now() + 30_000;
  let connected = false;
  while (Date.now() < deadline) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 1000 });
      connected = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  assert.ok(
    connected,
    `Không kết nối được MongoDB tạm ở ${uri}. Test bảo mật này cần binary \`mongod\` ` +
      `trên PATH (macOS: \`brew install mongodb-community\`) — KHÔNG được skip nó.`
  );

  userA = await seedUser("alice");
  userB = await seedUser("bob");
  userC = await seedUser("carol");

  convAC = await Conversation.create({ participants: [userA._id, userC._id] });
  convAB = await Conversation.create({ participants: [userA._id, userB._id] });
  convBC = await Conversation.create({ participants: [userB._id, userC._id] });

  msgInAC = await Message.create({
    conversationId: convAC._id,
    sender: userA._id,
    type: "media",
    media: LEGACY_MEDIA,
  });
});

after(async () => {
  await mongoose.disconnect().catch(() => {});
  mongod?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  if (dbPath) rmSync(dbPath, { recursive: true, force: true });
});

const callSendNext = async (authUserId: string, payload: any) => {
  messageSendLimiter.reset(authUserId);
  const io = fakeIo() as any;
  let res: any = null;
  await MessageController.sendNext(
    payload,
    (r: any) => {
      res = r;
    },
    fakeSocket(authUserId) as any,
    io
  );
  messageSendLimiter.reset(authUserId);
  return { res, io };
};

test("sendNext: participant forwards a message — media comes from the DB, not from the client", async () => {
  const { res, io } = await callSendNext(String(userA._id), {
    msgInfo: {
      _id: String(msgInAC._id),
      type: "media",
      media: CLIENT_INJECTED_MEDIA,
    },
    conversationsInfo: [{ _id: String(convAB._id), recipientId: String(userB._id) }],
  });

  assert.equal(res?.status, "success");

  const unreadDoc = await ConversationRead.findOne({
    conversationId: convAB._id,
    userId: userB._id,
  }).lean();
  assert.ok(unreadDoc, "ConversationRead document should be lazy-created for userB");
  assert.equal((unreadDoc as any)?.unreadCount, 1);

  const unreadEmit = io.emits.find(
    (e: any) => e.p === Route.MESSAGE + MESSAGE_PATH.UNREAD_UPDATE
  );
  assert.ok(unreadEmit, "sendNext must push an UNREAD_UPDATE event for the recipient");
  assert.equal(unreadEmit.target, `user:${userB._id}`);
  assert.equal(String(unreadEmit.d.conversationId), String(convAB._id));
  assert.equal(unreadEmit.d.unreadCount, 1);

  const forwarded = await Message.find({ conversationId: convAB._id }).lean();
  assert.equal(forwarded.length, 1);
  assert.deepEqual(
    (forwarded[0] as any).media.map((m: any) => m.url),
    LEGACY_MEDIA.map((m) => m.url)
  );
  assert.equal(
    JSON.stringify(forwarded[0]).includes("attacker.example.com"),
    false
  );
  assert.equal(String((forwarded[0] as any).parentMsg), String(msgInAC._id));
  assert.equal(String((forwarded[0] as any).sender), String(userA._id));
});

test("sendNext: IDOR — non-participant cannot forward a message from someone else's conversation", async () => {
  const beforeCount = await Message.countDocuments({});

  const { res, io } = await callSendNext(String(userB._id), {
    msgInfo: {
      _id: String(msgInAC._id),
      type: "media",
      media: CLIENT_INJECTED_MEDIA,
    },
    conversationsInfo: [{ _id: String(convBC._id), recipientId: String(userC._id) }],
  });

  assert.equal(res?.status, "error");
  assert.equal(res?.data, null);

  assert.equal(await Message.countDocuments({}), beforeCount);
  assert.equal(await Message.countDocuments({ conversationId: convBC._id }), 0);

  const leaked = JSON.stringify({ res, emits: io.emits });
  assert.equal(leaked.includes("legacy-cdn.example.com"), false);
  assert.equal(io.emits.length, 0);
});

test("sendNext: forwarding a non-existent message id is rejected", async () => {
  const beforeCount = await Message.countDocuments({});

  const { res } = await callSendNext(String(userA._id), {
    msgInfo: { _id: String(new mongoose.Types.ObjectId()), type: "media" },
    conversationsInfo: [{ _id: String(convAB._id), recipientId: String(userB._id) }],
  });

  assert.equal(res?.status, "error");
  assert.equal(await Message.countDocuments({}), beforeCount);
});
