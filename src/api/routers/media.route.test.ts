// Run with Node's built-in test runner: `npm test` (glob `src/api/routers/*.test.ts`).
//
// Phạm vi: Task 002 — endpoint ký batch Cloudinary (`POST /media/sign-upload`).
//
// Khác `post.route.test.ts`: ở đây router THẬT được `import` và mount trực tiếp. `post.route.ts`
// không import được vì kéo theo `feed/queue.ts` (mở Redis lúc import); chuỗi import của
// `media.route.ts` (`media.controller` -> `cloudinarySign` -> `mediaConvention`, cộng
// `protectRoute` -> model mongoose) KHÔNG mở connection nào lúc import, nên mount được bare.
//
// 2 thứ được stub, và chỉ 2:
//  - `User.findById` — để `protectRoute` xác định được danh tính mà không cần Mongo.
//  - biến môi trường Cloudinary — `api_sign_request` là hàm SHA1 thuần, chạy offline được.
// `validate()`, `mediaSignSchema`, `mediaSignLimiter`, `protectRoute`, `signBatch` đều là bản THẬT.
import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import express from "express";
import { ipKeyGenerator } from "express-rate-limit";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { z } from "zod";
import { MEDIA_PATH, Route } from "../../Breads-Shared/APIConfig.ts";
import logger from "../../core/logger.ts";
import { VALIDATION_ERROR_MESSAGE } from "../middlewares/validate.ts";
import { mediaSignLimiter } from "../middlewares/rateLimiter.ts";
import User from "../models/user.model.ts";
import { signBatch } from "../services/cloudinarySign.ts";
import {
  MEDIA_SIGN_BATCH_MAX,
  mediaSignSchema,
} from "../validators/media.validator.ts";
import mediaRouter from "./media.route.ts";

const VIEWER_ID = "652f1b2c3d4e5f6071829304";
const RECIPIENT_ID = "652f1b2c3d4e5f6071829305";
/** ObjectId hợp lệ về mặt cú pháp nhưng KHÔNG phải người đang đăng nhập — payload giả mạo. */
const FORGED_ID = "652f1b2c3d4e5f6071829399";
const SORTED_PAIR = [VIEWER_ID, RECIPIENT_ID].sort().join("_");

process.env.JWT_SECRET = "media-route-test-secret";
process.env.CLOUDINARY_CLOUD_NAME = "test-cloud";
process.env.CLOUDINARY_API_KEY = "test-api-key";
process.env.CLOUDINARY_API_SECRET = "test-api-secret";

const authToken = jwt.sign({ userId: VIEWER_ID }, process.env.JWT_SECRET);

// `protectRoute` gọi `User.findById(userId).select("-password")`. `lastActiveAt` để "mới" nên
// nhánh `User.updateOne` không chạy -> không cần stub thêm gì.
(User as any).findById = () => ({
  select: () =>
    Promise.resolve({
      _id: new mongoose.Types.ObjectId(VIEWER_ID),
      lastActiveAt: new Date(),
    }),
});

const silenceWarn = async (fn: () => unknown | Promise<unknown>) => {
  const original = logger.warn;
  (logger as any).warn = () => {};
  try {
    return await fn();
  } finally {
    (logger as any).warn = original;
  }
};

const errorHandler = (err, _req, res, _next) => {
  res.status(err.statusCode || err.status || 500).json({ message: err.message });
};

/** `req.ip` thật mà `mediaSignLimiter` dùng làm key — cần cho `resetKey()` ở test rate-limit. */
let lastIp: string | undefined;

const buildApp = () => {
  const app = express();
  app.use((req, _res, next) => {
    lastIp = req.ip;
    next();
  });
  app.use(Route.MEDIA, mediaRouter);
  app.use(errorHandler);
  return app;
};

const withServer = async (app, fn: (base: string) => Promise<void>) => {
  const server = app.listen(0);
  await once(server, "listening");
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
};

const signRequest = (base: string, body: unknown, token: string | null = authToken) =>
  fetch(`${base}${Route.MEDIA}${MEDIA_PATH.SIGN_UPLOAD}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

const MESSAGE_BODY = {
  entityType: "message",
  count: 3,
  recipientId: RECIPIENT_ID,
};

const SIGNATURE_FIELDS = [
  "apiKey",
  "cloudName",
  "publicId",
  "resourceType",
  "signature",
  "timestamp",
];

/* --------------------------------------------------- Test 1: signBatch (unit, service thật) */

// AC FR-1: đúng N phần tử, mỗi phần tử đủ 6 field. Assert trên KEY chứ không chỉ "không throw" —
// thiếu 1 field nào ở đây thì client không đủ tham số để POST lên Cloudinary.
test("FR-1: signBatch(message, count=3) trả 3 chữ ký, đủ 6 field, public_id đúng convention", () => {
  const signatures = signBatch({
    entityType: "message",
    count: 3,
    context: { senderId: VIEWER_ID, recipientId: RECIPIENT_ID },
  });

  assert.equal(signatures.length, 3);
  for (const item of signatures) {
    assert.deepEqual(Object.keys(item).sort(), SIGNATURE_FIELDS);
    assert.equal(typeof item.signature, "string");
    assert.ok(item.signature.length > 0, "chữ ký rỗng = client upload sẽ bị Cloudinary từ chối");
    assert.equal(typeof item.timestamp, "number");
    assert.equal(item.apiKey, "test-api-key");
    assert.equal(item.cloudName, "test-cloud");
    assert.match(item.publicId, new RegExp(`^message/${SORTED_PAIR}/[a-f0-9]{24}$`));
  }

  // Mỗi file phải có public_id RIÊNG — trùng nhau nghĩa là file thứ 2 ghi đè file thứ 1 trên
  // Cloudinary, tin nhắn mất ảnh mà không có lỗi nào.
  assert.equal(new Set(signatures.map((s) => s.publicId)).size, 3);
});

// AC FR-2: cùng service, đổi `entityType` -> đổi namespace + key.
test("FR-2: signBatch(post) sinh public_id dạng post/{authorId}/{generatedId}", () => {
  const signatures = signBatch({
    entityType: "post",
    count: 2,
    context: { authorId: VIEWER_ID },
  });

  assert.equal(signatures.length, 2);
  for (const item of signatures) {
    assert.deepEqual(Object.keys(item).sort(), SIGNATURE_FIELDS);
    assert.match(item.publicId, new RegExp(`^post/${VIEWER_ID}/[a-f0-9]{24}$`));
  }
});

// AC FR-7: assert rõ 2 GIÁ TRỊ KHÁC NHAU, không chỉ "không lỗi". `resource_type` nằm trong URL
// upload của Cloudinary — sai giá trị thì video upload hỏng dù chữ ký hợp lệ.
test("FR-7: item type=video nhận resourceType khác hẳn image/gif trong CÙNG 1 batch", () => {
  const signatures = signBatch({
    entityType: "post",
    count: 3,
    context: { authorId: VIEWER_ID },
    items: [{ type: "image" }, { type: "gif" }, { type: "video" }],
  });

  const [image, gif, video] = signatures.map((s) => s.resourceType);

  assert.equal(image, "image");
  assert.equal(gif, "image", "gif là 1 định dạng ảnh với Cloudinary, không phải resource type riêng");
  assert.equal(video, "video");
  assert.notEqual(video, image, "video KHÔNG được nhận cùng resourceType với image");
  assert.notEqual(video, gif, "video KHÔNG được nhận cùng resourceType với gif");
});

test("FR-7: items vắng mặt -> toàn bộ batch mặc định về image", () => {
  const signatures = signBatch({
    entityType: "post",
    count: 2,
    context: { authorId: VIEWER_ID },
  });
  assert.deepEqual(
    signatures.map((s) => s.resourceType),
    ["image", "image"]
  );
});

/* ------------------------------------------------------------ Test 2a: schema (cap FR-6) */

test("FR-6 (schema): count > 10 bị ZodError, count = 10 pass", () => {
  assert.equal(MEDIA_SIGN_BATCH_MAX, 10);
  assert.equal(
    mediaSignSchema.body.parse({ entityType: "post", count: MEDIA_SIGN_BATCH_MAX }).count,
    10
  );
  assert.throws(
    () => mediaSignSchema.body.parse({ entityType: "post", count: 11 }),
    z.ZodError
  );
  assert.throws(() => mediaSignSchema.body.parse({ entityType: "post", count: 0 }), z.ZodError);
});

test("schema: entityType=message BẮT BUỘC recipientId hợp lệ; post thì không nhận field đó", () => {
  assert.throws(
    () => mediaSignSchema.body.parse({ entityType: "message", count: 1 }),
    z.ZodError
  );
  assert.throws(
    () =>
      mediaSignSchema.body.parse({
        entityType: "message",
        count: 1,
        recipientId: "not-an-id",
      }),
    z.ZodError
  );
  const parsed: any = mediaSignSchema.body.parse({
    entityType: "post",
    count: 1,
    recipientId: RECIPIENT_ID,
  });
  assert.equal(parsed.recipientId, undefined, "recipientId vô nghĩa với post -> phải bị strip");
});

test("schema: items.length phải khớp count (lệch -> 400, không im lặng ký sai số lượng)", () => {
  assert.throws(
    () =>
      mediaSignSchema.body.parse({
        entityType: "post",
        count: 3,
        items: [{ type: "image" }],
      }),
    z.ZodError
  );
  assert.throws(
    () =>
      mediaSignSchema.body.parse({
        entityType: "post",
        count: 1,
        items: [{ type: "pdf" }],
      }),
    z.ZodError
  );
});

/* ------------------------------------- Test 4: danh tính lấy từ AUTH, không từ body client */

// AC FR-2 + "Tests to Write" #4. Đây là lớp phòng thủ THỨ NHẤT (schema strip). Lớp thứ hai
// (controller không đọc field đó) được chứng minh bằng test HTTP ngay dưới.
test("SEC (schema): authorId/senderId client tự khai bị STRIP khỏi body sau validate", () => {
  const parsed: any = mediaSignSchema.body.parse({
    entityType: "post",
    count: 1,
    authorId: FORGED_ID,
    senderId: FORGED_ID,
  });

  assert.equal(parsed.authorId, undefined);
  assert.equal(parsed.senderId, undefined);
  assert.deepEqual(Object.keys(parsed).sort(), ["count", "entityType"]);
});

/* ---------------------------------------------------------------------- HTTP thật */

// AC NFR-4 (SC-4): không JWT -> 401, và tuyệt đối không có chữ ký nào trong response.
test("NFR-4 (HTTP): request không JWT -> 401, không chữ ký nào được sinh ra", async () => {
  await withServer(buildApp(), async (base) => {
    const res = await signRequest(base, MESSAGE_BODY, null);

    assert.equal(res.status, 401);
    const body = (await res.json()) as any;
    assert.equal(body.metadata, undefined, "response 401 không được kèm bất kỳ chữ ký nào");
    assert.equal(JSON.stringify(body).includes("signature"), false);
  });
});

// AC FR-1 (end-to-end qua HTTP): shape response đúng contract mà task 012/Fe sẽ tiêu thụ.
test("FR-1 (HTTP): message count=3 -> 200 với metadata.signatures đúng 3 phần tử", async () => {
  await withServer(buildApp(), async (base) => {
    const res = await signRequest(base, MESSAGE_BODY);

    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.metadata.signatures.length, 3);
    for (const item of body.metadata.signatures) {
      assert.deepEqual(Object.keys(item).sort(), SIGNATURE_FIELDS);
      assert.match(item.publicId, new RegExp(`^message/${SORTED_PAIR}/[a-f0-9]{24}$`));
    }
  });
});

// AC FR-6 (cap, HTTP): phải dừng ở `validate()`, KHÔNG chạm tới `signBatch`. Bằng chứng: message
// đúng bằng `VALIDATION_ERROR_MESSAGE` (do `validate()` ném), và không có `metadata`.
test("FR-6 (HTTP): count=11 -> 400 tại validate, không tới signBatch", async () => {
  await silenceWarn(() =>
    withServer(buildApp(), async (base) => {
      const res = await signRequest(base, { entityType: "post", count: 11 });

      assert.equal(res.status, 400);
      const body = await res.json();
      assert.deepEqual(body, { message: VALIDATION_ERROR_MESSAGE });
    })
  );
});

// AC FR-2 + "Tests to Write" #4 (lớp phòng thủ thứ hai, qua HTTP thật): client gửi kèm
// `authorId`/`senderId` GIẢ -> `public_id` vẫn phải dựng từ `req.user._id` của token.
test("SEC (HTTP, post): authorId giả trong body bị bỏ qua, public_id dùng req.user._id", async () => {
  await withServer(buildApp(), async (base) => {
    const res = await signRequest(base, {
      entityType: "post",
      count: 1,
      authorId: FORGED_ID,
      senderId: FORGED_ID,
    });

    assert.equal(res.status, 200);
    const { publicId } = ((await res.json()) as any).metadata.signatures[0];

    assert.match(publicId, new RegExp(`^post/${VIEWER_ID}/[a-f0-9]{24}$`));
    assert.equal(
      publicId.includes(FORGED_ID),
      false,
      "id client tự khai KHÔNG được lọt vào public_id — nếu lọt, user A ghi được vào namespace user B"
    );
  });
});

test("SEC (HTTP, message): senderId giả bị bỏ qua, cặp trong public_id là viewer + recipientId", async () => {
  await withServer(buildApp(), async (base) => {
    const res = await signRequest(base, {
      entityType: "message",
      count: 1,
      recipientId: RECIPIENT_ID,
      senderId: FORGED_ID,
      authorId: FORGED_ID,
    });

    assert.equal(res.status, 200);
    const { publicId } = ((await res.json()) as any).metadata.signatures[0];

    assert.match(publicId, new RegExp(`^message/${SORTED_PAIR}/[a-f0-9]{24}$`));
    assert.equal(publicId.includes(FORGED_ID), false);
  });
});

/* -------------------------------------------------- rate-limit (chạy CUỐI: store dùng chung) */

// AC FR-6 (rate-limit). Test này phải đứng CUỐI file: `mediaSignLimiter` là instance module-level
// với in-memory store dùng chung, mọi test HTTP ở trên đều đã tiêu tốn hạn mức. `resetKey(req.ip)`
// đưa bộ đếm về 0 để đếm được CHÍNH XÁC 20, thay vì chỉ assert "có lúc nào đó ra 429".
test("FR-6 (rate-limit): request thứ 21/phút -> 429, KHÔNG phải 401", async () => {
  await withServer(buildApp(), async (base) => {
    // Warm-up 1 request để biết `req.ip` thật, rồi reset bộ đếm về 0. Key phải đi qua
    // `ipKeyGenerator` — keyGenerator mặc định của express-rate-limit v8 chuẩn hoá IPv6 về subnet,
    // nên `resetKey(req.ip)` thô sẽ trượt key và không reset gì cả.
    await signRequest(base, { entityType: "post", count: 1 });
    await (mediaSignLimiter as any).resetKey(ipKeyGenerator(lastIp as string));

    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      statuses.push((await signRequest(base, { entityType: "post", count: 1 })).status);
    }

    assert.deepEqual(
      statuses.slice(0, 20),
      Array(20).fill(200),
      "20 request đầu trong cùng cửa sổ phải qua hết — max của mediaSignLimiter là 20"
    );
    assert.equal(
      statuses[20],
      429,
      "request thứ 21 phải là 429 — JWT vẫn hợp lệ nên tuyệt đối không được ra 401"
    );
    assert.equal(statuses.includes(401), false, "không request nào được ra 401: auth luôn hợp lệ");
  });
});

/* ----------------------------------------------- constant submodule (Verification Checklist) */

test("FR-8: MEDIA_PATH.SIGN_UPLOAD tồn tại đúng namespace REST riêng", () => {
  assert.equal(Route.MEDIA, "/media");
  assert.equal(MEDIA_PATH.SIGN_UPLOAD, "/sign-upload");
});
