import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeText,
  sanitizeNoSqlPayload,
  checkPayloadSize,
  sendMessageSchema,
} from "./message.validator.js";

const VALID_ID = "6512f0a1b2c3d4e5f6a7b8c1";

test("sanitizeText: removes script tags and control characters", () => {
  const dirty = "Hello <script>alert('xss')</script> world \u0000!";
  const clean = sanitizeText(dirty);
  assert.equal(clean, "Hello  world !");
});

test("sanitizeNoSqlPayload: strips $ operator keys and dots from object", () => {
  const malicious = {
    content: "Safe text",
    $where: "malicious code",
    nested: {
      $ne: null,
      validKey: 123,
    },
  };

  const clean = sanitizeNoSqlPayload(malicious);
  assert.deepEqual(clean, {
    content: "Safe text",
    nested: {
      validKey: 123,
    },
  });
});

test("checkPayloadSize: correctly validates payload size limits", () => {
  const small = { msg: "hi" };
  assert.equal(checkPayloadSize(small, 1000), true);

  const big = { data: "a".repeat(2000) };
  assert.equal(checkPayloadSize(big, 1000), false);
});

test("sendMessageSchema: validates valid and invalid payloads", () => {
  const valid = {
    recipientId: VALID_ID,
    message: {
      content: "Hello there",
      media: [],
    },
  };
  assert.equal(sendMessageSchema.safeParse(valid).success, true);

  const invalidRecipient = {
    recipientId: "not-an-id",
    message: { content: "Hi" },
  };
  assert.equal(sendMessageSchema.safeParse(invalidRecipient).success, false);

  const tooLongContent = {
    recipientId: VALID_ID,
    message: { content: "x".repeat(5001) },
  };
  assert.equal(sendMessageSchema.safeParse(tooLongContent).success, false);
});
