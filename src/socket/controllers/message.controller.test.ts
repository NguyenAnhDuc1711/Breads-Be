import { test } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import Conversation from "../../api/models/conversation.model.js";
import Message from "../../api/models/message.model.js";
import User from "../../api/models/user.model.js";
import ConversationRead from "../../api/models/conversationRead.model.js";
import { MESSAGE_PATH, Route } from "../../Breads-Shared/APIConfig.js";
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
      [ConversationRead, "findOneAndUpdate", async () => ({ _id: "doc-1", lastReadAt: new Date(0) })],
      [ConversationRead, "updateOne", async () => {}],
      [ConversationRead, "aggregate", async () => []],
      [Message, "countDocuments", async () => 0],
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
      [ConversationRead, "findOneAndUpdate", async () => ({ _id: "doc-1", lastReadAt: new Date(0) })],
      [ConversationRead, "updateOne", async () => {}],
      [ConversationRead, "aggregate", async () => []],
      [Message, "countDocuments", async () => 0],
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
      [ConversationRead, "findOneAndUpdate", async () => ({ _id: "doc-1", lastReadAt: new Date(0) })],
      [ConversationRead, "updateOne", async () => {}],
      [ConversationRead, "aggregate", async () => []],
      [Message, "countDocuments", async () => 0],
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
  // Regression (plan-review CRIT-1): hành vi GỐC — đúng 1 emit GET_MESSAGE tới recipient — phải
  // còn nguyên, cộng thêm 1 emit UNREAD_UPDATE mới (FR-2/FR-3) cho cùng recipient (là participant
  // duy nhất khác sender trong conversation 1-1 này).
  assert.equal(io.emits.length, 2);
  const getMessageEmit = io.emits.find((e: any) => e.p === Route.MESSAGE + MESSAGE_PATH.GET_MESSAGE);
  assert.equal(getMessageEmit?.target, `user:${USER_B}`);
  const unreadEmit = io.emits.find((e: any) => e.p === Route.MESSAGE + MESSAGE_PATH.UNREAD_UPDATE);
  assert.equal(unreadEmit?.target, `user:${USER_B}`);
  assert.equal(unreadEmit?.d.conversationId, CONV_ID);
  assert.equal(typeof unreadEmit?.d.unreadCount, "number");
  assert.equal(typeof unreadEmit?.d.globalTotal, "number");
  messageSendLimiter.reset(USER_A);
});

test("sendMessage: with 3+ participants, unread is pushed to EVERY participant except sender (AD-6)", async () => {
  messageSendLimiter.reset(USER_A);
  let cbResult: any = null;
  const socket = fakeSocket(USER_A);
  const io = fakeIo() as any;

  // `sendMessage` chỉ biết 1 `recipientId` tường minh (USER_B), nhưng conversation thực tế có
  // 3 participant (USER_A, USER_B, USER_C) — vòng lặp unread-bookkeeping (AD-6) phải tự lấy
  // TOÀN BỘ participants từ `conversation`, không chỉ dựa vào biến `recipientId`.
  const mockConvQuery: any = {
    _id: CONV_ID,
    participants: [USER_A, USER_B, USER_C],
    save: async () => {},
    populate: () => ({
      populate: () => ({
        lean: async () => ({
          _id: CONV_ID,
          participants: [{ _id: USER_A }, { _id: USER_B }, { _id: USER_C }],
          lastMsgId: { _id: MSG_ID },
        }),
      }),
    }),
  };

  const recomputedFor: string[] = [];

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
                { _id: MSG_ID, conversationId: CONV_ID, sender: USER_A, content: "Hi group" },
              ],
            }),
          }),
        }),
      ],
      [User, "updateOne", async () => {}],
      [
        ConversationRead,
        "findOneAndUpdate",
        async (filter: any) => {
          recomputedFor.push(String(filter.userId));
          return { _id: `doc-${filter.userId}`, lastReadAt: new Date(0) };
        },
      ],
      [ConversationRead, "updateOne", async () => {}],
      [ConversationRead, "aggregate", async () => []],
      [Message, "countDocuments", async () => 0],
    ],
    async () => {
      await MessageController.sendMessage(
        { recipientId: USER_B, message: { content: "Hi group" } },
        (res: any) => {
          cbResult = res;
        },
        socket as any,
        io
      );
    }
  );

  assert.equal(cbResult?.status, "success");
  // 2 participant khác sender (USER_B, USER_C) — cả 2 phải được recompute VÀ nhận UNREAD_UPDATE,
  // không chỉ đúng 1 người theo `recipientId` cũ.
  assert.deepEqual(recomputedFor.sort(), [USER_B, USER_C].sort());
  const unreadEmits = io.emits.filter((e: any) => e.p === Route.MESSAGE + MESSAGE_PATH.UNREAD_UPDATE);
  assert.equal(unreadEmits.length, 2);
  assert.deepEqual(
    unreadEmits.map((e: any) => e.target).sort(),
    [`user:${USER_B}`, `user:${USER_C}`].sort()
  );
  messageSendLimiter.reset(USER_A);
});

test("sendMessage: unread bookkeeping failure does not break the send response (failure isolation)", async () => {
  messageSendLimiter.reset(USER_A);
  let cbResult: any = null;
  const socket = fakeSocket(USER_A);
  const io = fakeIo() as any;

  const mockConvQuery: any = {
    _id: CONV_ID,
    participants: [USER_A, USER_B],
    save: async () => {},
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
      [
        ConversationRead,
        "findOneAndUpdate",
        async () => {
          throw new Error("simulated DB failure in unread bookkeeping");
        },
      ],
    ],
    async () => {
      await MessageController.sendMessage(
        { recipientId: USER_B, message: { content: "Hello" } },
        (res: any) => {
          cbResult = res;
        },
        socket as any,
        io
      );
    }
  );

  assert.equal(
    cbResult?.status,
    "success",
    "a thrown error in unread bookkeeping must not fail the sender's response"
  );
  messageSendLimiter.reset(USER_A);
});

// ---------------------------------------------------------------------------
// FR-4 / Phần A — `sendMessage` media cutover (epic presigned-media-upload, task 010).
// Thứ tự check per-item BẮT BUỘC: (1) GIF skip → (2) flag + `data:` fallback → (3) validate strict.
// ---------------------------------------------------------------------------

const TEST_CLOUD_NAME = "test-cloud";
// `sortedPairId` = [senderId, recipientId].sort().join("_") — cùng công thức với task 001.
const SORTED_PAIR_AB = [USER_A, USER_B].sort().join("_");
const VALID_MEDIA_URL = `https://res.cloudinary.com/${TEST_CLOUD_NAME}/image/upload/v1700000000/message/${SORTED_PAIR_AB}/6512f0a1b2c3d4e5f6a7b8ff.png`;
// Đúng domain + đúng namespace nhưng SAI cặp hội thoại (key của cặp A-C).
const WRONG_PAIR_MEDIA_URL = `https://res.cloudinary.com/${TEST_CLOUD_NAME}/image/upload/v1700000000/message/${[
  USER_A,
  USER_C,
]
  .sort()
  .join("_")}/6512f0a1b2c3d4e5f6a7b8fe.png`;
const EXTERNAL_GIF_URL = "https://media.giphy.com/media/abc123/giphy.gif";
const DATA_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const LEGACY_UPLOADED_URL = `https://res.cloudinary.com/${TEST_CLOUD_NAME}/image/upload/v1/legacy-fallback.png`;

/**
 * Chạy `sendMessage` với toàn bộ tầng DB được stub, trả về:
 *  - `res`: giá trị cb nhận được
 *  - `inserted`: mảng message thực sự được đưa vào `Message.insertMany` ([] nếu không gọi)
 *  - `uploadCalls`: các lần `uploadFileFromBase64` thực sự chạy — SPY thật, bắt qua `axios.post`
 *    tới endpoint upload của Cloudinary (đây là side-effect duy nhất của hàm đó). Dùng để chứng
 *    minh nhánh (2) có chạy hay không, không chỉ suy ra từ kết quả cuối.
 */
const runSendMessageWithMedia = async (
  media: any[],
  { legacyFallback }: { legacyFallback: boolean }
) => {
  messageSendLimiter.reset(USER_A);
  const socket = fakeSocket(USER_A);
  const io = fakeIo() as any;

  const prevFlag = process.env.MEDIA_LEGACY_FALLBACK_ENABLED;
  const prevCloud = process.env.CLOUDINARY_CLOUD_NAME;
  process.env.CLOUDINARY_CLOUD_NAME = TEST_CLOUD_NAME;
  if (legacyFallback) {
    process.env.MEDIA_LEGACY_FALLBACK_ENABLED = "true";
  } else {
    delete process.env.MEDIA_LEGACY_FALLBACK_ENABLED;
  }

  const mockConvQuery: any = {
    _id: CONV_ID,
    participants: [USER_A, USER_B],
    save: async () => {},
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

  let res: any = null;
  let inserted: any[] = [];
  const uploadCalls: string[] = [];

  try {
    await withStubbedModel(
      [
        [Conversation, "findOne", () => mockConvQuery],
        [Conversation, "updateOne", async () => {}],
        [
          Message,
          "insertMany",
          async (msgs: any) => {
            inserted = msgs;
          },
        ],
        [
          Message,
          "find",
          () => ({
            populate: () => ({
              populate: () => ({
                populate: async () => [{ _id: MSG_ID, conversationId: CONV_ID }],
              }),
            }),
          }),
        ],
        [User, "updateOne", async () => {}],
        [ConversationRead, "findOneAndUpdate", async () => ({ _id: "doc-1", lastReadAt: new Date(0) })],
        [ConversationRead, "updateOne", async () => {}],
        [ConversationRead, "aggregate", async () => []],
        [Message, "countDocuments", async () => 0],
        [
          axios,
          "post",
          async (url: string) => {
            uploadCalls.push(url);
            return { data: { url: LEGACY_UPLOADED_URL } };
          },
        ],
      ],
      async () => {
        await MessageController.sendMessage(
          { recipientId: USER_B, message: { media } },
          (r: any) => {
            res = r;
          },
          socket as any,
          io
        );
      }
    );
  } finally {
    if (prevFlag === undefined) delete process.env.MEDIA_LEGACY_FALLBACK_ENABLED;
    else process.env.MEDIA_LEGACY_FALLBACK_ENABLED = prevFlag;
    if (prevCloud === undefined) delete process.env.CLOUDINARY_CLOUD_NAME;
    else process.env.CLOUDINARY_CLOUD_NAME = prevCloud;
    messageSendLimiter.reset(USER_A);
  }

  return { res, inserted, uploadCalls };
};

test("sendMessage: valid Cloudinary media URL is accepted and stored as-is", async () => {
  const { res, inserted } = await runSendMessageWithMedia(
    [{ url: VALID_MEDIA_URL, type: "image" }],
    { legacyFallback: false }
  );

  assert.equal(res?.status, "success");
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].media.length, 1);
  assert.equal(inserted[0].media[0].url, VALID_MEDIA_URL);
});

test("sendMessage: Cloudinary URL of ANOTHER conversation pair is rejected", async () => {
  const { res, inserted } = await runSendMessageWithMedia(
    [{ url: WRONG_PAIR_MEDIA_URL, type: "image" }],
    { legacyFallback: false }
  );

  assert.equal(res?.status, "error");
  assert.equal(res?.code, "INVALID_MEDIA_URL");
  assert.equal(inserted.length, 0);
});

test("sendMessage: mixed GIF + image batch (2 items) — both accepted (item-level carve-out)", async () => {
  const { res, inserted } = await runSendMessageWithMedia(
    [
      { url: EXTERNAL_GIF_URL, type: "gif" },
      { url: VALID_MEDIA_URL, type: "image" },
    ],
    { legacyFallback: false }
  );

  assert.equal(res?.status, "success");
  assert.equal(inserted.length, 1);
  // Cả 2 item cùng sống sót — GIF ngoài Cloudinary KHÔNG bị strict-validate loại bỏ dù
  // batch có nhiều hơn 1 phần tử (bug SCOPE-3 của flag `isAddGif` cấp batch cũ).
  assert.equal(inserted[0].media.length, 2);
  assert.equal(inserted[0].media[0].url, EXTERNAL_GIF_URL);
  assert.equal(inserted[0].media[1].url, VALID_MEDIA_URL);
});

test("sendMessage: `data:` URI is rejected explicitly when the legacy flag is OFF", async () => {
  const { res, inserted, uploadCalls } = await runSendMessageWithMedia(
    [{ url: DATA_URI, type: "image" }],
    { legacyFallback: false }
  );

  assert.equal(res?.status, "error");
  assert.equal(res?.code, "INVALID_MEDIA_URL");
  assert.match(res?.message, /invalid media url/i);
  assert.equal(inserted.length, 0);
  // Flag tắt ⇒ nhánh (2) bị bỏ qua, không có upload base64 nào chạy.
  assert.equal(uploadCalls.length, 0);
});

test("sendMessage: `data:` URI goes through the legacy base64 upload when the flag is ON", async () => {
  const { res, inserted } = await runSendMessageWithMedia(
    [{ url: DATA_URI, type: "image" }],
    { legacyFallback: true }
  );

  assert.equal(res?.status, "success");
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].media[0].url, LEGACY_UPLOADED_URL);
  assert.equal(inserted[0].media[0].type, "image");
});

test("sendMessage: check ORDER — flag+`data:` branch fires BEFORE validateMediaUrl (AD5-1)", async () => {
  // Cùng 1 input, chỉ khác giá trị flag. `uploadCalls` là spy trên side-effect DUY NHẤT của
  // `uploadFileFromBase64` (POST tới Cloudinary), nên nó chứng minh nhánh nào đã thực sự chạy.
  const flagOn = await runSendMessageWithMedia([{ url: DATA_URI, type: "image" }], {
    legacyFallback: true,
  });
  const flagOff = await runSendMessageWithMedia([{ url: DATA_URI, type: "image" }], {
    legacyFallback: false,
  });

  // Flag BẬT: nhánh (2) chặn trước ⇒ upload chạy, `validateMediaUrl` không bao giờ được tới
  // (nếu nó chạy trước thì `data:` URI đã bị reject và không có POST nào cả).
  assert.equal(flagOn.uploadCalls.length, 1);
  assert.match(flagOn.uploadCalls[0], /api\.cloudinary\.com\/v1_1\/.+\/auto\/upload$/);
  assert.equal(flagOn.res?.status, "success");

  // Flag TẮT: nhánh (2) bị bỏ qua ⇒ rơi xuống (3) và bị reject, không upload gì.
  assert.equal(flagOff.uploadCalls.length, 0);
  assert.equal(flagOff.res?.status, "error");
  assert.equal(flagOff.res?.code, "INVALID_MEDIA_URL");
});

// ---------------------------------------------------------------------------
// getConversations — chưa có coverage trước epic unread-message-count (task 013).
// ---------------------------------------------------------------------------

const CONV_ID_2 = "6512f0a1b2c3d4e5f6a7b8c4";

const mockAggregateResult = () => [
  {
    _id: CONV_ID,
    theme: "default",
    emoji: ":thumbsup:",
    participant: { _id: USER_B, username: "userB", avatar: "avaB" },
    lastMsg: [{ _id: MSG_ID, content: "Hello", sender: USER_B }],
  },
  {
    _id: CONV_ID_2,
    theme: "dark",
    emoji: ":heart:",
    participant: { _id: USER_C, username: "userC", avatar: "avaC" },
    lastMsg: [],
  },
];

test("getConversations: unauthenticated socket returns unauthorized error", async () => {
  let cbResult: any = null;
  const socket = fakeSocket();

  await MessageController.getConversations(
    {},
    (res: any) => { cbResult = res; },
    socket as any
  );

  assert.equal(cbResult?.status, "error");
  assert.equal(cbResult?.message, "Unauthorized");
});

test("getConversations: returns unreadCount per item + globalTotal, preserving original response shape (FR-6/FR-7, backward-compat)", async () => {
  let cbResult: any = null;
  const socket = fakeSocket(USER_A);

  await withStubbedModel(
    [
      [Conversation, "aggregate", async () => mockAggregateResult()],
      [
        ConversationRead,
        "find",
        () => ({
          lean: async () => [{ conversationId: CONV_ID, unreadCount: 3 }],
        }),
      ],
      [ConversationRead, "aggregate", async () => [{ _id: null, total: 3 }]],
    ],
    async () => {
      await MessageController.getConversations(
        { page: 1, limit: 15 },
        (res: any) => { cbResult = res; },
        socket as any
      );
    }
  );

  assert.equal(cbResult?.status, "success");
  // Backward-compat: `data` vẫn là MẢNG, field cũ còn nguyên.
  assert.ok(Array.isArray(cbResult.data));
  assert.equal(cbResult.data.length, 2);
  assert.equal(cbResult.data[0].theme, "default");
  assert.equal(cbResult.data[0].emoji, ":thumbsup:");
  assert.equal(cbResult.data[0].participant.username, "userB");
  assert.equal(cbResult.data[0].lastMsg._id, MSG_ID);
  // Field mới: unreadCount đúng cho conversation có cache (CONV_ID) và mặc định 0 cho
  // conversation chưa từng có ConversationRead (CONV_ID_2).
  assert.equal(cbResult.data[0].unreadCount, 3);
  assert.equal(cbResult.data[1].unreadCount, 0);
  // globalTotal ở CẤP NGOÀI response, không lồng vào từng item.
  assert.equal(cbResult.globalTotal, 3);
});

test("getConversations: NEVER calls recomputeUnreadCount from the read path (plan-review CRIT-2)", async () => {
  let cbResult: any = null;
  const socket = fakeSocket(USER_A);
  let recomputeEntryPointCalled = false;

  await withStubbedModel(
    [
      [Conversation, "aggregate", async () => mockAggregateResult()],
      [
        ConversationRead,
        "find",
        () => ({ lean: async () => [] }),
      ],
      [ConversationRead, "aggregate", async () => []],
      [
        ConversationRead,
        "findOneAndUpdate",
        async () => {
          // Đây là entry point DUY NHẤT của recomputeUnreadCount/markConversationRead — nếu
          // getConversations gọi tới đây tức là đã vi phạm CRIT-2 (đọc kèm ghi/recompute).
          recomputeEntryPointCalled = true;
          return { _id: "doc-1", lastReadAt: new Date(0) };
        },
      ],
    ],
    async () => {
      await MessageController.getConversations(
        {},
        (res: any) => { cbResult = res; },
        socket as any
      );
    }
  );

  assert.equal(cbResult?.status, "success");
  assert.equal(
    recomputeEntryPointCalled,
    false,
    "getConversations must only use getCachedUnreadCounts/getGlobalUnreadTotal — never recomputeUnreadCount"
  );
});

test("getConversations: degrades gracefully when unread read fails — original fields still returned", async () => {
  let cbResult: any = null;
  const socket = fakeSocket(USER_A);

  await withStubbedModel(
    [
      [Conversation, "aggregate", async () => mockAggregateResult()],
      [
        ConversationRead,
        "find",
        () => { throw new Error("simulated DB failure"); },
      ],
    ],
    async () => {
      await MessageController.getConversations(
        {},
        (res: any) => { cbResult = res; },
        socket as any
      );
    }
  );

  assert.equal(cbResult?.status, "success", "unread read failure must not fail the whole getConversations request");
  assert.equal(cbResult.data.length, 2);
  assert.equal(cbResult.data[0].theme, "default");
  assert.equal(cbResult.data[0].unreadCount, undefined, "degraded response simply omits unreadCount, doesn't crash");
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

// ---------------------------------------------------------------------------
// updateLastSeen — chưa có coverage trước epic unread-message-count (task 011).
// Baseline hành vi GỐC (usersSeen update, push otherParticipants) + hành vi MỚI (FR-4/FR-5)
// được viết cùng lúc để có 1 điểm quy chiếu regression rõ ràng cho các thay đổi sau này.
// ---------------------------------------------------------------------------

const mockUpdateLastSeenConversation = () => ({
  _id: CONV_ID,
  participants: [USER_A, USER_B],
});

const mockLastMsgUpdated = (overrides: any = {}) => ({
  _id: MSG_ID,
  conversationId: CONV_ID,
  createdAt: new Date("2026-03-01T00:00:00Z"),
  content: "Hello",
  ...overrides,
});

const stubbedMessageFindOneChain = (result: any) => ({
  populate: () => ({
    populate: () => ({
      populate: async () => result,
    }),
  }),
});

test("updateLastSeen: unauthenticated socket returns unauthorized error", async () => {
  let cbResult: any = null;
  const socket = fakeSocket();
  const io = fakeIo() as any;

  await MessageController.updateLastSeen(
    { lastMsg: { _id: MSG_ID, conversationId: CONV_ID } },
    (res: any) => { cbResult = res; },
    socket as any,
    io
  );

  assert.equal(cbResult?.status, "error");
  assert.equal(cbResult?.message, "Unauthorized");
});

test("updateLastSeen: marks messages as seen and notifies otherParticipants (original behavior, regression baseline)", async () => {
  let cbResult: any = null;
  const socket = fakeSocket(USER_A);
  const io = fakeIo() as any;
  let updateManyFilter: any = null;

  await withStubbedModel(
    [
      [Conversation, "findOne", async () => mockUpdateLastSeenConversation()],
      [
        Message,
        "updateMany",
        async (filter: any) => {
          updateManyFilter = filter;
          return { modifiedCount: 2 };
        },
      ],
      [Message, "findOne", () => stubbedMessageFindOneChain(mockLastMsgUpdated())],
      [ConversationRead, "findOneAndUpdate", async () => ({ _id: "doc-1", lastReadAt: new Date(0) })],
      [ConversationRead, "updateOne", async () => {}],
      [ConversationRead, "aggregate", async () => []],
      [Message, "countDocuments", async () => 0],
    ],
    async () => {
      await MessageController.updateLastSeen(
        { lastMsg: { _id: MSG_ID, conversationId: CONV_ID, createdAt: new Date("2026-03-01T00:00:00Z") } },
        (res: any) => { cbResult = res; },
        socket as any,
        io
      );
    }
  );

  // Hành vi GỐC không đổi:
  assert.equal(cbResult?.status, "success");
  assert.equal(cbResult?.data?._id, MSG_ID);
  assert.equal(String(updateManyFilter.usersSeen.$nin[0]), USER_A);
  const updateMsgEmit = io.emits.find((e: any) => e.p === Route.MESSAGE + MESSAGE_PATH.UPDATE_MSG);
  assert.ok(updateMsgEmit, "must still notify otherParticipants that the message was seen");
  assert.equal(updateMsgEmit.target, `user:${USER_B}`);
});

test("updateLastSeen: syncs unreadCount=0 to the CALLER's own room, separate from the otherParticipants push (FR-4/FR-5)", async () => {
  let cbResult: any = null;
  const socket = fakeSocket(USER_A);
  const io = fakeIo() as any;
  let markReadArgs: any = null;

  await withStubbedModel(
    [
      [Conversation, "findOne", async () => mockUpdateLastSeenConversation()],
      [Message, "updateMany", async () => ({ modifiedCount: 1 })],
      [Message, "findOne", () => stubbedMessageFindOneChain(mockLastMsgUpdated())],
      [
        ConversationRead,
        "findOneAndUpdate",
        async (filter: any) => {
          markReadArgs = filter;
          return { _id: "doc-1", lastReadAt: new Date(0) };
        },
      ],
      [ConversationRead, "updateOne", async () => {}],
      [ConversationRead, "aggregate", async () => [{ _id: null, total: 3 }]],
      [Message, "countDocuments", async () => 0],
    ],
    async () => {
      await MessageController.updateLastSeen(
        { lastMsg: { _id: MSG_ID, conversationId: CONV_ID, createdAt: new Date("2026-03-01T00:00:00Z") } },
        (res: any) => { cbResult = res; },
        socket as any,
        io
      );
    }
  );

  assert.equal(cbResult?.status, "success");
  assert.equal(String(markReadArgs.userId), USER_A, "markConversationRead must target the caller (authUserId), not otherParticipants");

  // 2 emit tách biệt: 1 tới otherParticipants (UPDATE_MSG, giữ nguyên), 1 tới CHÍNH authUserId
  // (UNREAD_UPDATE, mới) — không được nhầm path/recipient giữa 2 vòng.
  assert.equal(io.emits.length, 2);
  const updateMsgEmit = io.emits.find((e: any) => e.p === Route.MESSAGE + MESSAGE_PATH.UPDATE_MSG);
  assert.equal(updateMsgEmit.target, `user:${USER_B}`);
  const unreadEmit = io.emits.find((e: any) => e.p === Route.MESSAGE + MESSAGE_PATH.UNREAD_UPDATE);
  assert.equal(unreadEmit.target, `user:${USER_A}`);
  assert.equal(unreadEmit.d.unreadCount, 0);
  assert.equal(unreadEmit.d.globalTotal, 3);
});

test("updateLastSeen: unread bookkeeping failure does not break the existing usersSeen response (failure isolation)", async () => {
  let cbResult: any = null;
  const socket = fakeSocket(USER_A);
  const io = fakeIo() as any;

  await withStubbedModel(
    [
      [Conversation, "findOne", async () => mockUpdateLastSeenConversation()],
      [Message, "updateMany", async () => ({ modifiedCount: 1 })],
      [Message, "findOne", () => stubbedMessageFindOneChain(mockLastMsgUpdated())],
      [
        ConversationRead,
        "findOneAndUpdate",
        async () => { throw new Error("simulated DB failure"); },
      ],
    ],
    async () => {
      await MessageController.updateLastSeen(
        { lastMsg: { _id: MSG_ID, conversationId: CONV_ID, createdAt: new Date("2026-03-01T00:00:00Z") } },
        (res: any) => { cbResult = res; },
        socket as any,
        io
      );
    }
  );

  assert.equal(cbResult?.status, "success", "unread bookkeeping failure must not break the existing mark-as-seen response");
  const updateMsgEmit = io.emits.find((e: any) => e.p === Route.MESSAGE + MESSAGE_PATH.UPDATE_MSG);
  assert.ok(updateMsgEmit, "the pre-existing otherParticipants notification must still fire");
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
      [ConversationRead, "findOneAndUpdate", async () => ({ _id: "doc-1", lastReadAt: new Date(0) })],
      [ConversationRead, "updateOne", async () => {}],
      [ConversationRead, "aggregate", async () => []],
      [Message, "countDocuments", async () => 0],
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
  // Regression (plan-review CRIT-1): push báo-thu-hồi GỐC (UPDATE_MSG) phải còn nguyên, cộng
  // thêm push UNREAD_UPDATE mới (FR-2 trigger b / FR-3) cho cùng participant.
  assert.equal(io.emits.length, 2);
  const updateMsgEmit = io.emits.find((e: any) => e.p === Route.MESSAGE + MESSAGE_PATH.UPDATE_MSG);
  assert.equal(updateMsgEmit?.target, `user:${USER_B}`);
  const unreadEmit = io.emits.find((e: any) => e.p === Route.MESSAGE + MESSAGE_PATH.UNREAD_UPDATE);
  assert.equal(unreadEmit?.target, `user:${USER_B}`);
  assert.equal(unreadEmit?.d.conversationId, CONV_ID);
});

test("retrieveMsg: with 3+ participants, unread is recomputed and pushed to EVERY participant except sender", async () => {
  let cbResult: any = null;
  const socket = fakeSocket(USER_A);
  const io = fakeIo() as any;

  const mockMsg = { _id: MSG_ID, conversationId: CONV_ID, sender: USER_A, isRetrieve: true };
  const mockConv = { _id: CONV_ID, participants: [USER_A, USER_B, USER_C] };
  const recomputedFor: string[] = [];

  await withStubbedModel(
    [
      [Message, "findOne", async () => mockMsg],
      [Conversation, "findOne", async () => mockConv],
      [Message, "updateOne", async () => {}],
      [
        ConversationRead,
        "findOneAndUpdate",
        async (filter: any) => {
          recomputedFor.push(String(filter.userId));
          return { _id: `doc-${filter.userId}`, lastReadAt: new Date(0) };
        },
      ],
      [ConversationRead, "updateOne", async () => {}],
      [ConversationRead, "aggregate", async () => []],
      [Message, "countDocuments", async () => 0],
    ],
    async () => {
      await MessageController.retrieveMsg(
        { msgId: MSG_ID },
        (res: any) => { cbResult = res; },
        socket as any,
        io
      );
    }
  );

  assert.equal(cbResult?.status, "success");
  assert.deepEqual(recomputedFor.sort(), [USER_B, USER_C].sort());
  const unreadEmits = io.emits.filter((e: any) => e.p === Route.MESSAGE + MESSAGE_PATH.UNREAD_UPDATE);
  assert.equal(unreadEmits.length, 2);
});

test("retrieveMsg: unread bookkeeping failure does not break the existing recall notification (failure isolation)", async () => {
  let cbResult: any = null;
  const socket = fakeSocket(USER_A);
  const io = fakeIo() as any;

  const mockMsg = { _id: MSG_ID, conversationId: CONV_ID, sender: USER_A, isRetrieve: true };
  const mockConv = { _id: CONV_ID, participants: [USER_A, USER_B] };

  await withStubbedModel(
    [
      [Message, "findOne", async () => mockMsg],
      [Conversation, "findOne", async () => mockConv],
      [Message, "updateOne", async () => {}],
      [
        ConversationRead,
        "findOneAndUpdate",
        async () => { throw new Error("simulated DB failure"); },
      ],
    ],
    async () => {
      await MessageController.retrieveMsg(
        { msgId: MSG_ID },
        (res: any) => { cbResult = res; },
        socket as any,
        io
      );
    }
  );

  assert.equal(cbResult?.status, "success");
  const updateMsgEmit = io.emits.find((e: any) => e.p === Route.MESSAGE + MESSAGE_PATH.UPDATE_MSG);
  assert.ok(updateMsgEmit, "the pre-existing recall notification must still fire despite unread bookkeeping failure");
  assert.equal(updateMsgEmit.target, `user:${USER_B}`);
});

// ---------------------------------------------------------------------------
// Task 021 — SC-4 (NFR-1) và SC-7 across-the-board check.
// ---------------------------------------------------------------------------

const MESSAGE_CONTROLLER_SRC_PATH = "src/socket/controllers/message.controller.ts";

test("SC-4: unread-message-count code never calls fetchSockets()/getUserSocketsByUserIds() (NFR-1)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(MESSAGE_CONTROLLER_SRC_PATH, "utf8");
  assert.equal(
    /fetchSockets\(\)|getUserSocketsByUserIds/.test(src),
    false,
    "message.controller.ts must only reuse sendToSpecificUser's room-based emit, never the full-socket-scan pattern"
  );
});

test("SC-7: every UNREAD_UPDATE call site in the source sends all 3 payload fields", async () => {
  // Kiểm tra tĩnh (static), bổ sung cho assertion runtime đã có riêng ở từng handler (task
  // 010/011/012): mỗi khối gọi `sendToSpecificUser` với path `UNREAD_UPDATE` trong nguồn phải có
  // đủ literal `conversationId`, `unreadCount`, `globalTotal` trong payload — bắt được regression
  // dạng "thêm 1 call site mới nhưng quên 1 field" mà runtime test riêng lẻ có thể bỏ sót.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(MESSAGE_CONTROLLER_SRC_PATH, "utf8");

  const callSites = src.split("MESSAGE_PATH.UNREAD_UPDATE").length - 1;
  assert.ok(callSites >= 3, `expected at least 3 UNREAD_UPDATE call sites (sendMessage/sendNext, updateLastSeen, retrieveMsg), found ${callSites}`);

  // Mỗi khối payload theo path UNREAD_UPDATE (tìm bằng khoảng cách gần trong source) đều có đủ
  // 3 field — kiểm tra bằng cách quét từng đoạn 300 ký tự SAU mỗi lần xuất hiện MESSAGE_PATH.UNREAD_UPDATE.
  let idx = src.indexOf("MESSAGE_PATH.UNREAD_UPDATE");
  let checked = 0;
  while (idx !== -1) {
    const window = src.slice(idx, idx + 300);
    assert.match(window, /conversationId/, `call site at offset ${idx} missing conversationId`);
    assert.match(window, /unreadCount/, `call site at offset ${idx} missing unreadCount`);
    assert.match(window, /globalTotal/, `call site at offset ${idx} missing globalTotal`);
    checked += 1;
    idx = src.indexOf("MESSAGE_PATH.UNREAD_UPDATE", idx + 1);
  }
  assert.ok(checked >= 3);
});
