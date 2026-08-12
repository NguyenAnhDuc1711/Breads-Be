import { test } from "node:test";
import assert from "node:assert/strict";
import Notification from "../../api/models/notification.model.js";
import logger from "../../core/logger.js";
import NotificationController from "./notification.controller.js";

// Kỹ thuật này CHỈ ăn với property của một object đã import (Notification.find,
// logger.warn, ...). Gán đè một named function export từ file test KHÔNG có tác dụng
// dưới `npx tsx --test` — module gọi vẫn resolve về binding gốc, counter đứng yên và
// assertion "0 lần gọi" xanh một cách rỗng. Chỉ stub property, không stub named export.
const withStubbedModel = async (
  stubs: Array<[any, string, any]>,
  fn: () => Promise<void> | void
) => {
  const originals: Array<[any, string, any]> = stubs.map(([obj, prop]) => [
    obj,
    prop,
    obj[prop],
  ]);
  for (const [obj, prop, replacement] of stubs) {
    obj[prop] = replacement;
  }
  try {
    return await fn();
  } finally {
    for (const [obj, prop, original] of originals) {
      obj[prop] = original;
    }
  }
};

const fakeSocket = (userId?: string) => ({
  id: "sk-1",
  user: userId ? { userId } : undefined,
});
const fakeIo = () => {
  const emits: any[] = [];
  return {
    emits,
    to(id: any) {
      return { emit: (p: any, d: any) => emits.push({ id, p, d }) };
    },
  };
};

test("FR-2: socket chưa auth -> find/deleteMany/save/emit 0 lần, logger.warn 1 lần", async () => {
  let findCalls = 0;
  let deleteManyCalls = 0;
  let saveCalls = 0;
  let warnCalls = 0;
  const warnArgs: any[] = [];

  await withStubbedModel(
    [
      [Notification, "find", async () => { findCalls++; return []; }],
      [Notification, "deleteMany", async () => { deleteManyCalls++; }],
      [Notification.prototype, "save", async function (this: any) { saveCalls++; return this; }],
      [logger, "warn", (...args: any[]) => { warnCalls++; warnArgs.push(args); }],
    ],
    async () => {
      const socket = fakeSocket();
      const io = fakeIo();

      await NotificationController.create(
        { fromUser: "userX", toUsers: ["userY"], action: "like" },
        socket,
        io
      );

      assert.equal(findCalls, 0);
      assert.equal(deleteManyCalls, 0);
      assert.equal(saveCalls, 0);
      assert.equal(io.emits.length, 0);
      assert.equal(warnCalls, 1);
      assert.equal(warnArgs[0][0].socketId, socket.id);
      assert.equal(warnArgs[0][0].fromUser, "userX");
    }
  );
});

test("FR-2: fromUser lệch danh tính -> 0 lần chạm model, logger.warn 1 lần", async () => {
  let findCalls = 0;
  let deleteManyCalls = 0;
  let saveCalls = 0;
  let warnCalls = 0;
  const warnArgs: any[] = [];

  await withStubbedModel(
    [
      [Notification, "find", async () => { findCalls++; return []; }],
      [Notification, "deleteMany", async () => { deleteManyCalls++; }],
      [Notification.prototype, "save", async function (this: any) { saveCalls++; return this; }],
      [logger, "warn", (...args: any[]) => { warnCalls++; warnArgs.push(args); }],
    ],
    async () => {
      const socket = fakeSocket("userX");
      const io = fakeIo();

      await NotificationController.create(
        { fromUser: "userY", toUsers: ["userZ"], action: "like" },
        socket,
        io
      );

      assert.equal(findCalls, 0);
      assert.equal(deleteManyCalls, 0);
      assert.equal(saveCalls, 0);
      assert.equal(io.emits.length, 0);
      assert.equal(warnCalls, 1);
      assert.equal(warnArgs[0][0].socketId, socket.id);
      assert.equal(warnArgs[0][0].fromUser, "userY");
    }
  );
});

test("FR-2: fromUser khớp danh tính -> luồng cũ chạy (Notification.find được gọi)", async () => {
  let findCalls = 0;

  await withStubbedModel(
    [
      // Dừng ngay sau khi ghi nhận lượt gọi find, tránh chạm các bước sau (save/aggregate/Mongo
      // thật) có thể treo test. try/catch containment ở controller nuốt lỗi này.
      [Notification, "find", async () => { findCalls++; throw new Error("stop-after-find"); }],
      [logger, "error", () => {}],
    ],
    async () => {
      const socket = fakeSocket("userX");
      const io = fakeIo();

      await assert.doesNotReject(
        NotificationController.create(
          { fromUser: "userX", toUsers: ["userY"], action: "like" },
          socket,
          io
        )
      );

      assert.ok(findCalls >= 1);
    }
  );
});

test("FAIL-1: Notification.find throw -> create không reject, logger.error 1 lần", async () => {
  let errorCalls = 0;
  const errorArgs: any[] = [];

  await withStubbedModel(
    [
      [Notification, "find", async () => { throw new Error("boom"); }],
      [logger, "error", (...args: any[]) => { errorCalls++; errorArgs.push(args); }],
    ],
    async () => {
      const socket = fakeSocket("userX");
      const io = fakeIo();

      await assert.doesNotReject(
        NotificationController.create(
          { fromUser: "userX", toUsers: ["userY"], action: "like" },
          socket,
          io
        )
      );

      assert.equal(errorCalls, 1);
      assert.ok(errorArgs[0][0].err);
    }
  );
});
