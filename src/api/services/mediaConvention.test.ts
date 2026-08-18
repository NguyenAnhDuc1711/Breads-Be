// Run with Node's built-in test runner: `npm test` (glob `src/api/services/*.test.ts`).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  generatePublicId,
  isMediaLegacyFallbackEnabled,
  parsePublicId,
} from "./mediaConvention.ts";

test("generatePublicId: message A->B và B->A cùng sortedPairId (order-independence)", () => {
  const ab = generatePublicId("message", { senderId: "A", recipientId: "B" });
  const ba = generatePublicId("message", { senderId: "B", recipientId: "A" });

  const [, pairAB] = ab.split("/");
  const [, pairBA] = ba.split("/");

  assert.equal(pairAB, "A_B");
  assert.equal(pairBA, "A_B");
  assert.match(ab, /^message\/A_B\/[a-f0-9]{24}$/);
  assert.match(ba, /^message\/A_B\/[a-f0-9]{24}$/);
});

test("generatePublicId: post có dạng post/{authorId}/{generatedId}", () => {
  const publicId = generatePublicId("post", { authorId: "U" });
  assert.match(publicId, /^post\/U\/[a-f0-9]{24}$/);
});

test("generatePublicId: throw khi thiếu context field bắt buộc", () => {
  assert.throws(() => generatePublicId("message", { senderId: "A" }));
  assert.throws(() => generatePublicId("message", { recipientId: "B" }));
  assert.throws(() => generatePublicId("post", {}));
});

test("parsePublicId: round-trip đúng với output của generatePublicId (message)", () => {
  const publicId = generatePublicId("message", {
    senderId: "A",
    recipientId: "B",
  });
  const generatedId = publicId.split("/")[2];

  assert.deepEqual(parsePublicId(publicId), {
    namespace: "message",
    key: "A_B",
    generatedId,
  });
});

test("parsePublicId: round-trip đúng với output của generatePublicId (post)", () => {
  const publicId = generatePublicId("post", { authorId: "U" });
  const generatedId = publicId.split("/")[2];

  assert.deepEqual(parsePublicId(publicId), {
    namespace: "post",
    key: "U",
    generatedId,
  });
});

test("parsePublicId: round-trip qua 1 URL Cloudinary đầy đủ", () => {
  const publicId = generatePublicId("post", { authorId: "U" });
  const generatedId = publicId.split("/")[2];
  const url = `https://res.cloudinary.com/demo/image/upload/v1700000000/${publicId}.jpg`;

  assert.deepEqual(parsePublicId(url), {
    namespace: "post",
    key: "U",
    generatedId,
  });
});

test("parsePublicId: trả null cho chuỗi rỗng", () => {
  assert.equal(parsePublicId(""), null);
});

test("parsePublicId: trả null cho URL ngoài Cloudinary (không đúng shape)", () => {
  assert.equal(
    parsePublicId("https://images.unsplash.com/photo-1500000000000"),
    null,
  );
});

test("parsePublicId: trả null cho public_id sai namespace", () => {
  assert.equal(parsePublicId("video/A_B/507f1f77bcf86cd799439011"), null);
});

test("isMediaLegacyFallbackEnabled: mặc định false khi env không set", () => {
  delete process.env.MEDIA_LEGACY_FALLBACK_ENABLED;
  assert.equal(isMediaLegacyFallbackEnabled(), false);
});

test('isMediaLegacyFallbackEnabled: true khi set đúng "true"', () => {
  process.env.MEDIA_LEGACY_FALLBACK_ENABLED = "true";
  assert.equal(isMediaLegacyFallbackEnabled(), true);
  delete process.env.MEDIA_LEGACY_FALLBACK_ENABLED;
});

test("isMediaLegacyFallbackEnabled: false cho mọi biến thể khác (so sánh chặt)", () => {
  for (const v of ["TRUE", "1", "yes"]) {
    process.env.MEDIA_LEGACY_FALLBACK_ENABLED = v;
    assert.equal(isMediaLegacyFallbackEnabled(), false);
  }
  delete process.env.MEDIA_LEGACY_FALLBACK_ENABLED;
});
