import { test } from "node:test";
import assert from "node:assert/strict";
import ConversationRead from "../models/conversationRead.model.js";
import Message from "../models/message.model.js";
import {
  recomputeUnreadCount,
  markConversationRead,
  getGlobalUnreadTotal,
  getCachedUnreadCounts,
  getRolloutCutoverAt,
} from "./conversationRead.service.js";

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

const CONV_ID = "6512f0a1b2c3d4e5f6a7b8c0";
const USER_A = "6512f0a1b2c3d4e5f6a7b8c1";
const USER_B = "6512f0a1b2c3d4e5f6a7b8c2";
const DOC_ID = "6512f0a1b2c3d4e5f6a7b8d0";

const applyGroundTruthFilter = (
  messages: Array<{ sender: string; isRetrieve?: boolean; createdAt: Date }>,
  { lastReadAt, userId }: { lastReadAt: Date; userId: string }
) =>
  messages.filter(
    (m) =>
      m.createdAt.getTime() > lastReadAt.getTime() &&
      m.sender !== userId &&
      m.isRetrieve !== true
  ).length;

test("recomputeUnreadCount: lazy-creates a document when none exists (upsert)", async () => {
  let upsertCalled = false;
  const fakeLastReadAt = new Date("2026-01-01T00:00:00Z");

  await withStubbedModel(
    [
      [
        ConversationRead,
        "findOneAndUpdate",
        async (_filter: any, _update: any, opts: any) => {
          assert.equal(opts.upsert, true, "must upsert atomically, not find-then-create");
          upsertCalled = true;
          return { _id: DOC_ID, lastReadAt: fakeLastReadAt };
        },
      ],
      [ConversationRead, "updateOne", async () => {}],
      [Message, "countDocuments", async () => 0],
    ],
    async () => {
      const count = await recomputeUnreadCount({ conversationId: CONV_ID, userId: USER_A });
      assert.equal(count, 0);
    }
  );

  assert.equal(upsertCalled, true);
});

test("recomputeUnreadCount: excludes the user's own messages (own-message exclusion)", async () => {
  const lastReadAt = new Date("2026-01-01T00:00:00Z");
  const messages = [
    { sender: USER_B, isRetrieve: false, createdAt: new Date("2026-01-02T00:00:00Z") },
    { sender: USER_A, isRetrieve: false, createdAt: new Date("2026-01-03T00:00:00Z") },
  ];

  await withStubbedModel(
    [
      [ConversationRead, "findOneAndUpdate", async () => ({ _id: DOC_ID, lastReadAt })],
      [ConversationRead, "updateOne", async () => {}],
      [
        Message,
        "countDocuments",
        async (filter: any) => {
          assert.deepEqual(Object.keys(filter.sender), ["$ne"]);
          return applyGroundTruthFilter(messages, { lastReadAt, userId: USER_A });
        },
      ],
    ],
    async () => {
      const count = await recomputeUnreadCount({ conversationId: CONV_ID, userId: USER_A });
      assert.equal(count, 1, "own message must not count toward the user's own unreadCount");
    }
  );
});

test("recomputeUnreadCount: excludes recalled messages (isRetrieve: true)", async () => {
  const lastReadAt = new Date("2026-01-01T00:00:00Z");
  const messages = [
    { sender: USER_B, isRetrieve: false, createdAt: new Date("2026-01-02T00:00:00Z") },
    { sender: USER_B, isRetrieve: true, createdAt: new Date("2026-01-03T00:00:00Z") },
  ];

  await withStubbedModel(
    [
      [ConversationRead, "findOneAndUpdate", async () => ({ _id: DOC_ID, lastReadAt })],
      [ConversationRead, "updateOne", async () => {}],
      [
        Message,
        "countDocuments",
        async (filter: any) => {
          assert.deepEqual(Object.keys(filter.isRetrieve), ["$ne"]);
          return applyGroundTruthFilter(messages, { lastReadAt, userId: USER_A });
        },
      ],
    ],
    async () => {
      const count = await recomputeUnreadCount({ conversationId: CONV_ID, userId: USER_A });
      assert.equal(count, 1, "recalled message must not count as unread");
    }
  );
});

test("recomputeUnreadCount: counts correctly with valid + own + recalled messages mixed", async () => {
  const lastReadAt = new Date("2026-01-01T00:00:00Z");
  const messages = [
    { sender: USER_B, isRetrieve: false, createdAt: new Date("2026-01-02T00:00:00Z") },
    { sender: USER_B, isRetrieve: false, createdAt: new Date("2026-01-02T01:00:00Z") },
    { sender: USER_A, isRetrieve: false, createdAt: new Date("2026-01-02T02:00:00Z") },
    { sender: USER_B, isRetrieve: true, createdAt: new Date("2026-01-02T03:00:00Z") },
  ];

  await withStubbedModel(
    [
      [ConversationRead, "findOneAndUpdate", async () => ({ _id: DOC_ID, lastReadAt })],
      [ConversationRead, "updateOne", async () => {}],
      [
        Message,
        "countDocuments",
        async () => applyGroundTruthFilter(messages, { lastReadAt, userId: USER_A }),
      ],
    ],
    async () => {
      const count = await recomputeUnreadCount({ conversationId: CONV_ID, userId: USER_A });
      assert.equal(count, 2);
    }
  );
});

test("markConversationRead: sets unreadCount to 0 and updates lastReadAt/lastReadMessageId", async () => {
  const lastMsg = { _id: "6512f0a1b2c3d4e5f6a7b8f9", createdAt: new Date("2026-02-01T00:00:00Z") };
  let updatedFields: any = null;

  await withStubbedModel(
    [
      [ConversationRead, "findOneAndUpdate", async () => ({ _id: DOC_ID, lastReadAt: new Date(0) })],
      [
        ConversationRead,
        "updateOne",
        async (_filter: any, update: any) => {
          updatedFields = { ...updatedFields, ...update };
        },
      ],
      [Message, "countDocuments", async () => 0],
    ],
    async () => {
      const count = await markConversationRead({
        conversationId: CONV_ID,
        userId: USER_A,
        lastMsg,
      });
      assert.equal(count, 0);
    }
  );

  assert.equal(updatedFields.lastReadAt.getTime(), lastMsg.createdAt.getTime());
  assert.equal(String(updatedFields.lastReadMessageId), lastMsg._id);
  assert.equal(updatedFields.unreadCount, 0);
});

test("getGlobalUnreadTotal: sums unreadCount across conversations, returns 0 when none exist", async () => {
  await withStubbedModel(
    [[ConversationRead, "aggregate", async () => [{ _id: null, total: 7 }]]],
    async () => {
      assert.equal(await getGlobalUnreadTotal(USER_A), 7);
    }
  );

  await withStubbedModel([[ConversationRead, "aggregate", async () => []]], async () => {
    assert.equal(await getGlobalUnreadTotal(USER_A), 0, "must not throw when user has no ConversationRead docs");
  });
});

test("getCachedUnreadCounts: returns cached values, defaults missing conversations to 0, never writes", async () => {
  const convA = "6512f0a1b2c3d4e5f6a7b8e1";
  const convB = "6512f0a1b2c3d4e5f6a7b8e2";

  let writeCalled = false;

  await withStubbedModel(
    [
      [
        ConversationRead,
        "find",
        () => ({
          lean: async () => [{ conversationId: convA, unreadCount: 3 }],
        }),
      ],
      [ConversationRead, "updateOne", async () => { writeCalled = true; }],
      [ConversationRead, "findOneAndUpdate", async () => { writeCalled = true; }],
    ],
    async () => {
      const result = await getCachedUnreadCounts({ conversationIds: [convA, convB], userId: USER_A });
      assert.equal(result[convA], 3);
      assert.equal(result[convB], 0);
    }
  );

  assert.equal(writeCalled, false, "getCachedUnreadCounts must never write — read-only by contract (CRIT-2)");
});

test("recomputeUnreadCount: concurrent lazy-create for the same (conversation, user) does not throw", async () => {
  let callCount = 0;
  await withStubbedModel(
    [
      [
        ConversationRead,
        "findOneAndUpdate",
        async () => {
          callCount += 1;
          return { _id: DOC_ID, lastReadAt: getRolloutCutoverAt() };
        },
      ],
      [ConversationRead, "updateOne", async () => {}],
      [Message, "countDocuments", async () => 0],
    ],
    async () => {
      await Promise.all([
        recomputeUnreadCount({ conversationId: CONV_ID, userId: USER_A }),
        recomputeUnreadCount({ conversationId: CONV_ID, userId: USER_A }),
      ]);
    }
  );
  assert.equal(callCount, 2);
});

test("NFR-4: lazy-create defaults lastReadAt to the rollout cutover, not the message history", async () => {
  const cutover = new Date("2026-06-01T00:00:00Z");
  const oldMessages = [
    { sender: USER_B, isRetrieve: false, createdAt: new Date("2020-01-01T00:00:00Z") },
  ];

  const originalEnv = process.env.UNREAD_COUNT_ROLLOUT_AT;
  process.env.UNREAD_COUNT_ROLLOUT_AT = cutover.toISOString();

  try {
    await withStubbedModel(
      [
        [
          ConversationRead,
          "findOneAndUpdate",
          async (_filter: any, update: any) => {
            assert.equal(update.$setOnInsert.lastReadAt.getTime(), cutover.getTime());
            return { _id: DOC_ID, lastReadAt: cutover };
          },
        ],
        [ConversationRead, "updateOne", async () => {}],
        [
          Message,
          "countDocuments",
          async () => applyGroundTruthFilter(oldMessages, { lastReadAt: cutover, userId: USER_A }),
        ],
      ],
      async () => {
        const count = await recomputeUnreadCount({ conversationId: CONV_ID, userId: USER_A });
        assert.equal(count, 0, "messages predating rollout cutover must not count as unread");
      }
    );
  } finally {
    if (originalEnv === undefined) delete process.env.UNREAD_COUNT_ROLLOUT_AT;
    else process.env.UNREAD_COUNT_ROLLOUT_AT = originalEnv;
  }
});

test("NFR-3: a stale write from a race self-heals on the next recompute call", async () => {
  const staleLastReadAt = new Date("2026-01-01T00:00:00Z");
  const currentLastReadAtInDb = new Date("2026-01-02T00:00:00Z");

  let dbUnreadCount = 0;

  dbUnreadCount = await (async () => {
    let result = 0;
    await withStubbedModel(
      [
        [ConversationRead, "findOneAndUpdate", async () => ({ _id: DOC_ID, lastReadAt: staleLastReadAt })],
        [ConversationRead, "updateOne", async (_f: any, update: any) => { result = update.unreadCount; }],
        [
          Message,
          "countDocuments",
          async () =>
            applyGroundTruthFilter(
              [{ sender: USER_B, isRetrieve: false, createdAt: new Date("2026-01-01T12:00:00Z") }],
              { lastReadAt: staleLastReadAt, userId: USER_A }
            ),
        ],
      ],
      async () => { await recomputeUnreadCount({ conversationId: CONV_ID, userId: USER_A }); }
    );
    return result;
  })();

  assert.equal(dbUnreadCount, 1, "the stale write does land a wrong (non-zero) value — that's the race");

  let healedCount = -1;
  await withStubbedModel(
    [
      [ConversationRead, "findOneAndUpdate", async () => ({ _id: DOC_ID, lastReadAt: currentLastReadAtInDb })],
      [ConversationRead, "updateOne", async (_f: any, update: any) => { healedCount = update.unreadCount; }],
      [
        Message,
        "countDocuments",
        async () =>
          applyGroundTruthFilter(
            [{ sender: USER_B, isRetrieve: false, createdAt: new Date("2026-01-01T12:00:00Z") }],
            { lastReadAt: currentLastReadAtInDb, userId: USER_A }
          ),
      ],
    ],
    async () => { await recomputeUnreadCount({ conversationId: CONV_ID, userId: USER_A }); }
  );

  assert.equal(
    healedCount,
    0,
    "the next recompute call must self-heal to the correct value (message predates T1, already read)"
  );
});

test("G-1: recomputeUnreadCount throws on missing conversationId/userId instead of silently using a random id", async () => {
  await assert.rejects(() => recomputeUnreadCount({ conversationId: undefined, userId: USER_A }));
  await assert.rejects(() => recomputeUnreadCount({ conversationId: CONV_ID, userId: undefined }));
});

test("G-1: markConversationRead throws on missing arguments", async () => {
  await assert.rejects(() =>
    markConversationRead({ conversationId: undefined, userId: USER_A, lastMsg: { _id: "x", createdAt: new Date() } })
  );
  await assert.rejects(() =>
    markConversationRead({ conversationId: CONV_ID, userId: USER_A, lastMsg: {} as any })
  );
});

test("G-1: getGlobalUnreadTotal throws on missing userId", async () => {
  await assert.rejects(() => getGlobalUnreadTotal(undefined));
});

test("G-1: getCachedUnreadCounts throws on missing userId or non-array conversationIds", async () => {
  await assert.rejects(() => getCachedUnreadCounts({ conversationIds: [CONV_ID], userId: undefined }));
  await assert.rejects(() => getCachedUnreadCounts({ conversationIds: undefined as any, userId: USER_A }));
});
