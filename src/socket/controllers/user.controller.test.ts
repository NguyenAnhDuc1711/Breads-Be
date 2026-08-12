import { test } from "node:test";
import assert from "node:assert/strict";
import logger from "../../core/logger.js";
import UserController from "./user.controller.js";

// Kỹ thuật này CHỈ ăn với property của một object đã import (io.fetchSockets,
// logger.warn, ...). Gán đè một named function export (getFriendsSocketInfo) từ file
// test KHÔNG có tác dụng dưới `npx tsx --test` — module gọi vẫn resolve về binding gốc,
// counter đứng yên và assertion "0 lần gọi" xanh một cách rỗng. Vì vậy test này đo qua
// hiệu ứng quan sát được thật duy nhất: io.fetchSockets (được getFriendsSocketInfo gọi
// gián tiếp qua getAllSockets), KHÔNG stub getFriendsSocketInfo.

const fakeSocket = (userId?: string, initialData: any = { initial: true }) => ({
  id: "sk-1",
  data: initialData,
  user: userId ? { userId } : undefined,
});

const fakeIo = (sockets: any[] = []) => {
  let fetchSocketsCalls = 0;
  return {
    get fetchSocketsCalls() {
      return fetchSocketsCalls;
    },
    fetchSockets: async () => {
      fetchSocketsCalls++;
      return sockets;
    },
  };
};

const fakeIoThrowing = () => ({
  fetchSockets: async () => {
    throw new Error("fetchSockets boom");
  },
});

const withStubbedLogger = async (
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

test("FR-7: auth X + payload userId Y -> socket.data.userId === X, friendsInfo khác rỗng, fetchSockets >= 1 lần", async () => {
  const socket = fakeSocket("userX");
  // socket giả đại diện cho "bạn chung" đã online: userId nằm trong giao của
  // userFollowed/userFollowing của payload.
  const friendSocket = { id: "sk-friend", data: { id: "sk-friend", userId: "friendId" } };
  const io = fakeIo([friendSocket as any]);

  await UserController.connect(
    {
      userId: "userY",
      userFollowed: ["friendId", "other1"],
      userFollowing: ["friendId", "other2"],
    },
    socket as any,
    io as any
  );

  assert.equal(socket.data.userId, "userX");
  assert.ok(!JSON.stringify(socket.data).includes("userY"));
  // Positive control: pipeline getFriendsSocketInfo -> getAllSockets -> io.fetchSockets
  // thực sự chạy và tìm thấy bạn chung.
  assert.ok(io.fetchSocketsCalls >= 1);
  assert.equal((socket.data as any).friendsInfo.length, 1);
  assert.equal((socket.data as any).friendsInfo[0].userId, "friendId");
});

test("FR-7: socket chưa auth -> socket.data không gán, fetchSockets 0 lần, logger.warn 1 lần", async () => {
  const initialData = { initial: true };
  const socket = fakeSocket(undefined, initialData);
  const io = fakeIo([]);
  let warnCalls = 0;
  const warnArgs: any[] = [];

  await withStubbedLogger(
    [[logger, "warn", (...args: any[]) => { warnCalls++; warnArgs.push(args); }]],
    async () => {
      await UserController.connect(
        {
          userId: "userY",
          userFollowed: ["friendId"],
          userFollowing: ["friendId"],
        },
        socket as any,
        io as any
      );
    }
  );

  assert.equal(socket.data, initialData);
  assert.equal(io.fetchSocketsCalls, 0);
  assert.equal(warnCalls, 1);
  assert.equal(warnArgs[0][0].socketId, socket.id);
  assert.equal(warnArgs[0][0].claimedUserId, "userY");
});

test("FR-7: auth X + payload userId X -> socket.data giống hệt hành vi trước fix", async () => {
  const socket = fakeSocket("userX");
  const io = fakeIo([]);

  await UserController.connect(
    {
      userId: "userX",
      userFollowed: ["a"],
      userFollowing: ["b"],
    },
    socket as any,
    io as any
  );

  assert.deepEqual(socket.data, {
    id: "sk-1",
    userId: "userX",
    userFollowed: ["a"],
    userFollowing: ["b"],
    friendsInfo: [],
  });
});

test("FAIL-4: io.fetchSockets throw -> connect không reject, logger.error 1 lần", async () => {
  const socket = fakeSocket("userX");
  const io = fakeIoThrowing();
  let errorCalls = 0;
  const errorArgs: any[] = [];

  await withStubbedLogger(
    [[logger, "error", (...args: any[]) => { errorCalls++; errorArgs.push(args); }]],
    async () => {
      await assert.doesNotReject(
        UserController.connect(
          {
            userId: "userX",
            userFollowed: ["friendId"],
            userFollowing: ["friendId"],
          },
          socket as any,
          io as any
        )
      );
    }
  );

  assert.equal(errorCalls, 1);
  assert.ok(errorArgs[0][0].err);
});
