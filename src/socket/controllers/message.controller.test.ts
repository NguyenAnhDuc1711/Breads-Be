import { test } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
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
