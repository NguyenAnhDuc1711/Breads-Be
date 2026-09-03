import { test } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import {
  getUserSocketByUserId,
  getUserSocketsByUserIds,
} from "./user.js";

const fakeIo = (sockets: any[]) =>
  ({ fetchSockets: async () => sockets } as any);
const sk = (id: string, data: any) => ({ data: { id, ...data } });

const USER_A = "6512f0a1b2c3d4e5f6a7b8c1";
const USER_B = "6512f0a1b2c3d4e5f6a7b8c2";
const USER_C = "6512f0a1b2c3d4e5f6a7b8c3";

test("FR-5: 2 user online -> trả 2 socket id", async () => {
  const io = fakeIo([
    sk("sock-a", { userId: USER_A }),
    sk("sock-b", { userId: USER_B }),
    sk("sock-c", { userId: USER_C }),
  ]);

  const ids = await getUserSocketsByUserIds([USER_A, USER_B], io);

  assert.deepEqual(ids.sort(), ["sock-a", "sock-b"]);
});

test("FR-5: 1 user 2 tab -> trả 2 socket id", async () => {
  const io = fakeIo([
    sk("tab-1", { userId: USER_A }),
    sk("tab-2", { userId: USER_A }),
    sk("other", { userId: USER_B }),
  ]);

  const ids = await getUserSocketsByUserIds([USER_A], io);

  assert.deepEqual(ids.sort(), ["tab-1", "tab-2"]);
});

test("FR-5: 1 online + 1 offline -> trả 1 id, không throw", async () => {
  const io = fakeIo([sk("sock-a", { userId: USER_A })]);

  const ids = await getUserSocketsByUserIds([USER_A, USER_B], io);

  assert.deepEqual(ids, ["sock-a"]);
});

test("FR-5: không ai online -> trả []", async () => {
  assert.deepEqual(await getUserSocketsByUserIds([USER_A], fakeIo([])), []);
  assert.deepEqual(await getUserSocketsByUserIds([], fakeIo([])), []);
});

test("FR-5/TEST-1: getUserSocketsByUserIds nhận ObjectId -> vẫn khớp socket", async () => {
  const io = fakeIo([sk("sock-a", { userId: USER_A })]);
  const objectId = new mongoose.Types.ObjectId(USER_A);

  const ids = await getUserSocketsByUserIds([objectId], io);

  assert.deepEqual(ids, ["sock-a"]);
});

test("FR-5/TEST-1: wrapper getUserSocketByUserId nhận ObjectId (call site message.ts) -> vẫn khớp", async () => {
  const objectId = new mongoose.Types.ObjectId(USER_A);
  const io = fakeIo([
    sk("sock-b", { userId: USER_B }),
    sk("sock-a", { userId: USER_A }),
  ]);

  assert.equal(await getUserSocketByUserId(objectId as any, io), "sock-a");
  const ioObj = fakeIo([sk("sock-a", { userId: objectId })]);
  assert.equal(await getUserSocketByUserId(USER_A, ioObj), "sock-a");
});

test("FR-5: wrapper trả undefined khi 0 socket, trả phần tử [0] khi nhiều socket", async () => {
  assert.equal(await getUserSocketByUserId(USER_A, fakeIo([])), undefined);

  const io = fakeIo([
    sk("tab-1", { userId: USER_A }),
    sk("tab-2", { userId: USER_A }),
  ]);
  assert.equal(await getUserSocketByUserId(USER_A, io), "tab-1");
});

test("FR-5/ARCH-4: socket chưa connect (data rỗng) không lọt kết quả; input [undefined, null] -> []", async () => {
  const io = fakeIo([
    { data: {} },
    { data: { id: "no-user" } },
    sk("sock-a", { userId: USER_A }),
  ]);

  assert.deepEqual(await getUserSocketsByUserIds([USER_A], io), ["sock-a"]);
  assert.deepEqual(await getUserSocketsByUserIds([undefined, null], io), []);
  assert.equal(await getUserSocketByUserId(undefined as any, io), undefined);
});
