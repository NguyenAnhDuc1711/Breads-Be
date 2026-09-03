import { test } from "node:test";
import assert from "node:assert/strict";
import Notification from "../../api/models/notification.model.js";
import User from "../../api/models/user.model.js";
import logger from "../../core/logger.js";
import NotificationController from "./notification.controller.js";

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
const fakeIo = (sockets: any[] = []) => {
  const emits: any[] = [];
  return {
    emits,
    fetchSockets: async () => sockets,
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

const U_FROM = "6512f0a1b2c3d4e5f6a7b8c1";
const U_TO_1 = "6512f0a1b2c3d4e5f6a7b8c2";
const U_TO_2 = "6512f0a1b2c3d4e5f6a7b8c3";
const POST_1 = "6512f0a1b2c3d4e5f6a7b8d1";
const POST_2 = "6512f0a1b2c3d4e5f6a7b8d2";
const EXISTING_ID = "6512f0a1b2c3d4e5f6a7b8e1";

const spy = (findResults: any[][] = []) => {
  const st = {
    findFilters: [] as any[],
    deleteManyFilters: [] as any[],
    pipelines: [] as any[],
    updateManyArgs: [] as any[],
    updateOneCalls: 0,
    saveCalls: 0,
    errors: [] as any[],
  };
  let findIdx = 0;
  const stubs: Array<[any, string, any]> = [
    [
      Notification,
      "find",
      async (filter: any) => {
        st.findFilters.push(filter);
        return findResults[findIdx++] ?? [];
      },
    ],
    [
      Notification,
      "deleteMany",
      async (filter: any) => {
        st.deleteManyFilters.push(filter);
      },
    ],
    [
      Notification.prototype,
      "save",
      async function (this: any) {
        st.saveCalls++;
        return this;
      },
    ],
    [
      Notification,
      "aggregate",
      async (pipeline: any) => {
        st.pipelines.push(pipeline);
        return [{ _id: "n1" }];
      },
    ],
    [
      User,
      "updateMany",
      async (filter: any, update: any) => {
        st.updateManyArgs.push([filter, update]);
      },
    ],
    [
      User,
      "updateOne",
      async () => {
        st.updateOneCalls++;
      },
    ],
    [logger, "error", (...args: any[]) => st.errors.push(args)],
  ];
  return { st, stubs };
};

const projectOf = (pipeline: any[]) =>
  pipeline.find((stage) => stage.$project)?.$project;

test("FR-4: REPLY khác target -> filter find có target khác nhau, deleteMany 0 lần, save lần 2", async () => {
  const { st, stubs } = spy([[], []]);

  await withStubbedModel(stubs, async () => {
    const socket = fakeSocket(U_FROM);
    const io = fakeIo();
    const base = { fromUser: U_FROM, toUsers: [U_TO_1], action: "reply" };

    await NotificationController.create({ ...base, target: POST_1 }, socket, io);
    await NotificationController.create({ ...base, target: POST_2 }, socket, io);

    assert.deepEqual(st.errors, []);
    assert.equal(st.findFilters.length, 2);
    assert.equal(String(st.findFilters[0].target), POST_1);
    assert.equal(String(st.findFilters[1].target), POST_2);
    assert.notEqual(
      String(st.findFilters[0].target),
      String(st.findFilters[1].target)
    );
    assert.equal(st.deleteManyFilters.length, 0);
    assert.equal(st.saveCalls, 2);
  });
});

test("FR-4: FOLLOW không target -> filter có target: {$exists:false}, deleteMany 1 lần", async () => {
  const { st, stubs } = spy([[], [{ _id: EXISTING_ID }]]);

  await withStubbedModel(stubs, async () => {
    const socket = fakeSocket(U_FROM);
    const io = fakeIo();
    const payload = { fromUser: U_FROM, toUsers: [U_TO_1], action: "follow" };

    await NotificationController.create(payload, socket, io);
    await NotificationController.create(payload, socket, io);

    assert.deepEqual(st.errors, []);
    const filter = st.findFilters[0];
    assert.equal(Object.hasOwn(filter, "target"), true);
    assert.notEqual(filter.target, undefined);
    assert.deepEqual(filter.target, { $exists: false });

    assert.equal(st.deleteManyFilters.length, 1);
    assert.deepEqual(
      st.deleteManyFilters[0]._id.$in.map(String),
      [EXISTING_ID]
    );
  });
});

test("FR-4: cùng action + cùng target -> dedupe cũ giữ nguyên (deleteMany 1 lần)", async () => {
  const { st, stubs } = spy([[{ _id: EXISTING_ID }]]);

  await withStubbedModel(stubs, async () => {
    await NotificationController.create(
      {
        fromUser: U_FROM,
        toUsers: [U_TO_1],
        action: "reply",
        target: POST_1,
      },
      fakeSocket(U_FROM),
      fakeIo()
    );

    assert.deepEqual(st.errors, []);
    assert.equal(String(st.findFilters[0].target), POST_1);
    assert.equal(st.deleteManyFilters.length, 1);
    assert.equal(st.saveCalls, 0);
  });
});

test("FR-5: sendTo 2 user online -> io.to().emit đúng 2 lần với 2 id khác nhau", async () => {
  const { st, stubs } = spy([[]]);

  await withStubbedModel(stubs, async () => {
    const socket = fakeSocket(U_FROM);
    const io = fakeIo([
      { data: { id: "sock-to-1", userId: U_TO_1 } },
      { data: { id: "sock-from", userId: U_FROM } },
      { data: { id: "sock-to-2", userId: U_TO_2 } },
    ]);

    await NotificationController.create(
      {
        fromUser: U_FROM,
        toUsers: [U_TO_1, U_TO_2, U_FROM],
        action: "reply",
        target: POST_1,
      },
      socket,
      io
    );

    assert.deepEqual(st.errors, []);
    assert.equal(io.emits.length, 2);
    const ids = io.emits.map((e: any) => e.id).sort();
    assert.deepEqual(ids, ["sock-to-1", "sock-to-2"]);
    assert.equal(ids.includes("sock-from"), false);
  });
});

test("FR-5: User.updateMany 1 lần với filter _id.$in = sendTo (không updateOne, không toUsers thô)", async () => {
  const { st, stubs } = spy([[]]);

  await withStubbedModel(stubs, async () => {
    await NotificationController.create(
      {
        fromUser: U_FROM,
        toUsers: [U_TO_1, U_TO_2, U_FROM],
        action: "reply",
        target: POST_1,
      },
      fakeSocket(U_FROM),
      fakeIo()
    );

    assert.deepEqual(st.errors, []);
    assert.equal(st.updateOneCalls, 0);
    assert.equal(st.updateManyArgs.length, 1);
    const [filter, update] = st.updateManyArgs[0];
    assert.deepEqual(filter._id.$in.map(String).sort(), [U_TO_1, U_TO_2].sort());
    assert.equal(filter._id.$in.map(String).includes(U_FROM), false);
    assert.deepEqual(update, { hasNewNotify: true });
  });
});

test("FR-3: $project của socket create chứa $ifNull cho isRead", async () => {
  const { st, stubs } = spy([[]]);

  await withStubbedModel(stubs, async () => {
    await NotificationController.create(
      {
        fromUser: U_FROM,
        toUsers: [U_TO_1],
        action: "reply",
        target: POST_1,
      },
      fakeSocket(U_FROM),
      fakeIo()
    );

    assert.deepEqual(st.errors, []);
    assert.equal(st.pipelines.length, 1);
    const project = projectOf(st.pipelines[0]);
    assert.ok(project, "pipeline phải có stage $project");
    assert.deepEqual(project.isRead, { $ifNull: ["$isRead", false] });
    assert.notEqual(project.isRead, 1);
  });
});
