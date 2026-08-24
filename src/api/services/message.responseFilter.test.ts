import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REQUIRED_MESSAGE_FIELDS,
  REQUIRED_CONVERSATION_FIELDS,
} from "./message.ts";
import { stripEmptyOptionalFields } from "../../utils/emptyFieldFilter.ts";

test("REQUIRED_MESSAGE_FIELDS chốt đúng: _id, conversationId, sender, createdAt", () => {
  assert.deepEqual(
    [...REQUIRED_MESSAGE_FIELDS].sort(),
    ["_id", "conversationId", "createdAt", "sender"].sort(),
  );
});

test("REQUIRED_CONVERSATION_FIELDS chốt đúng: _id, participant, createdAt, updatedAt", () => {
  assert.deepEqual(
    [...REQUIRED_CONVERSATION_FIELDS].sort(),
    ["_id", "createdAt", "participant", "updatedAt"].sort(),
  );
});

test("stripEmptyOptionalFields(message): lược media/files/links/reacts/usersSeen rỗng, content rỗng, __v, giữ required", () => {
  const msg = {
    _id: "m1",
    conversationId: "c1",
    sender: "u1",
    createdAt: new Date("2026-08-24T00:00:00Z"),
    content: "",
    media: [],
    files: [],
    links: [],
    reacts: [],
    usersSeen: [],
    __v: 0,
  };
  const result = stripEmptyOptionalFields(msg, REQUIRED_MESSAGE_FIELDS);
  assert.equal(result._id, "m1");
  assert.equal(result.conversationId, "c1");
  assert.equal(result.sender, "u1");
  assert.equal(result.content, undefined); // optional rỗng -> bị lược
  assert.equal(result.media, undefined); // optional rỗng -> bị lược
  assert.equal(result.files, undefined); // optional rỗng -> bị lược
  assert.equal(result.links, undefined); // optional rỗng -> bị lược
  assert.equal(result.reacts, undefined); // optional rỗng -> bị lược
  assert.equal(result.usersSeen, undefined); // optional rỗng -> bị lược
  assert.equal(result.__v, undefined); // __v luôn bị xoá
});

test("stripEmptyOptionalFields(message): giữ nguyên field không rỗng", () => {
  const msg = {
    _id: "m1",
    conversationId: "c1",
    sender: "u1",
    createdAt: new Date("2026-08-24T00:00:00Z"),
    content: "hello",
    media: [{ url: "test.png" }],
    links: ["l1"],
    usersSeen: ["u2"],
  };
  const result = stripEmptyOptionalFields(msg, REQUIRED_MESSAGE_FIELDS);
  assert.equal(result.content, "hello");
  assert.deepEqual(result.media, [{ url: "test.png" }]);
  assert.deepEqual(result.links, ["l1"]);
  assert.deepEqual(result.usersSeen, ["u2"]);
});

test("stripEmptyOptionalFields(conversation): lược các field rỗng, giữ required", () => {
  const conversation = {
    _id: "c1",
    participant: {
      _id: "u2",
      username: "user2",
      avatar: "avatar.png",
    },
    createdAt: new Date("2026-08-24T00:00:00Z"),
    updatedAt: new Date("2026-08-24T00:00:00Z"),
    msgIds: [],
    __v: 0,
  };
  const result = stripEmptyOptionalFields(conversation, REQUIRED_CONVERSATION_FIELDS);
  assert.equal(result._id, "c1");
  assert.deepEqual(result.participant, {
    _id: "u2",
    username: "user2",
    avatar: "avatar.png",
  });
  assert.equal(result.msgIds, undefined);
  assert.equal(result.__v, undefined);
});
