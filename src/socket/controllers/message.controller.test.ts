import { test } from "node:test";
import assert from "node:assert/strict";
import Conversation from "../../api/models/conversation.model.js";
import Message from "../../api/models/message.model.js";
import User from "../../api/models/user.model.js";
import logger from "../../core/logger.js";
import MessageController from "./message.controller.js";
import { messageSendLimiter, messageActionLimiter } from "../middlewares/rateLimiter.js";

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
    to(target: string) {
      return {
        emit: (p: any, d: any) => emits.push({ target, p, d }),
      };
    },
  };
};

const USER_A = "6512f0a1b2c3d4e5f6a7b8c1";
const USER_B = "6512f0a1b2c3d4e5f6a7b8c2";
const USER_C = "6512f0a1b2c3d4e5f6a7b8c3";
const CONV_ID = "6512f0a1b2c3d4e5f6a7b8c0";
const MSG_ID = "6512f0a1b2c3d4e5f6a7b8f9";

test("sendMessage: unauthenticated socket returns unauthorized error", async () => {
  let cbResult: any = null;
  const socket = fakeSocket();
  const io = fakeIo() as any;

  await MessageController.sendMessage(
    { recipientId: USER_B, message: { content: "Hello" } },
    (res: any) => {
      cbResult = res;
    },
    socket as any,
    io
  );

  assert.equal(cbResult?.status, "error");
  assert.equal(cbResult?.message, "Unauthorized");
});

test("sendMessage: sending to self returns error", async () => {
  let cbResult: any = null;
  const socket = fakeSocket(USER_A);
  const io = fakeIo() as any;

  await MessageController.sendMessage(
    { recipientId: USER_A, message: { content: "Hello self" } },
    (res: any) => {
      cbResult = res;
    },
    socket as any,
    io
  );

  assert.equal(cbResult?.status, "error");
  assert.equal(cbResult?.message, "Invalid recipient");
});

test("sendMessage: rate limit blocks spamming exceeding limit", async () => {
  messageSendLimiter.reset(USER_A);
  const socket = fakeSocket(USER_A);
  const io = fakeIo() as any;
  let lastResult: any = null;

  const mockConv = {
    _id: CONV_ID,
    participants: [USER_A, USER_B],
    save: async () => {},
  };

  const mockConvQuery: any = {
    ...mockConv,
    populate: () => ({
      populate: () => ({
        lean: async () => ({
          _id: CONV_ID,
          participants: [{ _id: USER_A }, { _id: USER_B }],
          lastMsgId: { _id: MSG_ID },
        }),
      }),
    }),
  };

  await withStubbedModel(
    [
      [Conversation, "findOne", () => mockConvQuery],
      [Conversation, "updateOne", async () => {}],
      [Message, "insertMany", async () => {}],
      [
        Message,
        "find",
        () => ({
          populate: () => ({
            populate: () => ({
              populate: async () => [
                { _id: MSG_ID, conversationId: CONV_ID, sender: USER_A, content: "Hello" },
              ],
            }),
          }),
        }),
      ],
      [User, "updateOne", async () => {}],
    ],
    async () => {
      for (let i = 0; i < 6; i++) {
        await MessageController.sendMessage(
          { recipientId: USER_B, message: { content: `Msg ${i}` } },
          (res: any) => {
            lastResult = res;
          },
          socket as any,
          io
        );
      }
    }
  );

  assert.equal(lastResult?.status, "error");
  assert.equal(lastResult?.code, "RATE_LIMIT_EXCEEDED");
  messageSendLimiter.reset(USER_A);
});

test("sendMessage: sanitized text removes dangerous script tags", async () => {
  messageSendLimiter.reset(USER_A);
  let cbResult: any = null;
  const socket = fakeSocket(USER_A);
  const io = fakeIo() as any;

  const mockConv = {
    _id: CONV_ID,
    participants: [USER_A, USER_B],
    save: async () => {},
  };

  const mockConvQuery: any = {
    ...mockConv,
    populate: () => ({
      populate: () => ({
        lean: async () => ({
          _id: CONV_ID,
          participants: [
            { _id: USER_A, username: "userA", avatar: "avaA" },
            { _id: USER_B, username: "userB", avatar: "avaB" },
          ],
          lastMsgId: { _id: MSG_ID, content: "Clean text", sender: USER_A, createdAt: new Date() },
        }),
      }),
    }),
  };

  let insertedMessages: any[] = [];

  await withStubbedModel(
    [
      [Conversation, "findOne", () => mockConvQuery],
      [Conversation, "updateOne", async () => {}],
      [Message, "insertMany", async (msgs: any) => { insertedMessages = msgs; }],
      [
        Message,
        "find",
        () => ({
          populate: () => ({
            populate: () => ({
              populate: async () => [
                { _id: MSG_ID, conversationId: CONV_ID, sender: USER_A, content: "Clean text" },
              ],
            }),
          }),
        }),
      ],
      [User, "updateOne", async () => {}],
    ],
    async () => {
      await MessageController.sendMessage(
        {
          recipientId: USER_B,
          message: { content: "Hello <script>alert('hack')</script> world" },
        },
        (res: any) => {
          cbResult = res;
        },
        socket as any,
        io
      );
    }
  );

  assert.equal(cbResult?.status, "success");
  assert.equal(insertedMessages.length, 1);
  assert.equal(insertedMessages[0].content, "Hello  world");
  messageSendLimiter.reset(USER_A);
});

test("sendMessage: authenticated user emits to room user:recipientId and saves message", async () => {
  messageSendLimiter.reset(USER_A);
  let cbResult: any = null;
  const socket = fakeSocket(USER_A);
  const io = fakeIo() as any;

  const mockConv = {
    _id: CONV_ID,
    participants: [USER_A, USER_B],
    save: async () => {},
  };

  const mockConvQuery: any = {
    ...mockConv,
    populate: () => ({
      populate: () => ({
        lean: async () => ({
          _id: CONV_ID,
          participants: [
            { _id: USER_A, username: "userA", avatar: "avaA" },
            { _id: USER_B, username: "userB", avatar: "avaB" },
          ],
          lastMsgId: { _id: MSG_ID, content: "Hello", sender: USER_A, createdAt: new Date() },
        }),
      }),
    }),
  };

  let updateOneCalled = false;
  let insertManyCalled = false;

  await withStubbedModel(
    [
      [Conversation, "findOne", () => mockConvQuery],
      [Conversation, "updateOne", async () => { updateOneCalled = true; }],
      [Message, "insertMany", async () => { insertManyCalled = true; }],
      [
        Message,
        "find",
        () => ({
          populate: () => ({
            populate: () => ({
              populate: async () => [
                { _id: MSG_ID, conversationId: CONV_ID, sender: USER_A, content: "Hello" },
              ],
            }),
          }),
        }),
      ],
      [User, "updateOne", async () => {}],
    ],
    async () => {
      await MessageController.sendMessage(
        { recipientId: USER_B, senderId: "FAKE_USER", message: { content: "Hello" } },
        (res: any) => {
          cbResult = res;
        },
        socket as any,
        io
      );
    }
  );

  assert.equal(cbResult?.status, "success");
  assert.equal(updateOneCalled, true);
  assert.equal(insertManyCalled, true);
  assert.equal(io.emits.length, 1);
  assert.equal(io.emits[0].target, `user:${USER_B}`);
  messageSendLimiter.reset(USER_A);
});

test("getMessages: unauthenticated socket returns unauthorized error", async () => {
  let cbResult: any = null;
  const socket = fakeSocket();

  await MessageController.getMessages(
    { conversationId: CONV_ID },
    (res: any) => {
      cbResult = res;
    },
    socket as any
  );

  assert.equal(cbResult?.status, "error");
  assert.equal(cbResult?.message, "Unauthorized");
});

test("getMessages: non-participant socket gets access denied", async () => {
  let cbResult: any = null;
  const socket = fakeSocket(USER_C);

  await withStubbedModel(
    [[Conversation, "findOne", async () => null]],
    async () => {
      await MessageController.getMessages(
        { conversationId: CONV_ID },
        (res: any) => {
          cbResult = res;
        },
        socket as any
      );
    }
  );

  assert.equal(cbResult?.status, "error");
  assert.match(cbResult?.message, /access denied/i);
});

test("retrieveMsg: non-sender cannot retrieve message", async () => {
  let cbResult: any = null;
  const socket = fakeSocket(USER_B);
  const io = fakeIo() as any;

  const mockMsg = {
    _id: MSG_ID,
    conversationId: CONV_ID,
    sender: USER_A,
  };

  await withStubbedModel(
    [[Message, "findOne", async () => mockMsg]],
    async () => {
      await MessageController.retrieveMsg(
        { msgId: MSG_ID },
        (res: any) => {
          cbResult = res;
        },
        socket as any,
        io
      );
    }
  );

  assert.equal(cbResult?.status, "error");
  assert.equal(cbResult?.message, "Only sender can retrieve message");
});

test("retrieveMsg: sender can retrieve and emits update to room", async () => {
  let cbResult: any = null;
  const socket = fakeSocket(USER_A);
  const io = fakeIo() as any;

  const mockMsg = {
    _id: MSG_ID,
    conversationId: CONV_ID,
    sender: USER_A,
    isRetrieve: true,
  };

  const mockConv = {
    _id: CONV_ID,
    participants: [USER_A, USER_B],
  };

  let updateOneCalled = false;

  await withStubbedModel(
    [
      [Message, "findOne", async () => mockMsg],
      [Conversation, "findOne", async () => mockConv],
      [Message, "updateOne", async () => { updateOneCalled = true; }],
    ],
    async () => {
      await MessageController.retrieveMsg(
        { msgId: MSG_ID },
        (res: any) => {
          cbResult = res;
        },
        socket as any,
        io
      );
    }
  );

  assert.equal(cbResult?.status, "success");
  assert.equal(updateOneCalled, true);
  assert.equal(io.emits.length, 1);
  assert.equal(io.emits[0].target, `user:${USER_B}`);
});
