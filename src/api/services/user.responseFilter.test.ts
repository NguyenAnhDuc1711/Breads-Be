// Mở rộng lean-api-response sang User (tương ứng post.responseFilter.test.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { REQUIRED_USER_FIELDS } from "./user.ts";
import { stripEmptyOptionalFields } from "../../utils/emptyFieldFilter.ts";

test("REQUIRED_USER_FIELDS chốt đúng: _id, name, username, avatar, bio, email, role", () => {
  assert.deepEqual(
    [...REQUIRED_USER_FIELDS].sort(),
    ["_id", "avatar", "bio", "email", "name", "role", "username"].sort(),
  );
});

test("stripEmptyOptionalFields(user): lược followed/following/collection/links rỗng, giữ required", () => {
  const user = {
    _id: "u1",
    name: "A",
    username: "a",
    avatar: "x",
    bio: "",
    email: "a@x.com",
    role: 1,
    followed: [],
    following: [],
    collection: [],
    links: [],
    __v: 0,
  };
  const result = stripEmptyOptionalFields(user, REQUIRED_USER_FIELDS);
  assert.equal(result.bio, ""); // required, giữ dù rỗng-hợp-lệ
  assert.equal(result.followed, undefined);
  assert.equal(result.following, undefined);
  assert.equal(result.collection, undefined);
  assert.equal(result.links, undefined);
  assert.equal(result.__v, undefined);
});

test("stripEmptyOptionalFields(user): giữ nguyên field không rỗng", () => {
  const user = {
    _id: "u1",
    name: "A",
    username: "a",
    avatar: "x",
    bio: "hi",
    email: "a@x.com",
    role: 1,
    followed: ["u2"],
    collection: ["p1"],
  };
  const result = stripEmptyOptionalFields(user, REQUIRED_USER_FIELDS);
  assert.deepEqual(result.followed, ["u2"]);
  assert.deepEqual(result.collection, ["p1"]);
});

test("stripEmptyOptionalFields(user): mảng rỗng trong getUsersByPage kết quả được lược đúng", () => {
  const users = [
    {
      _id: "u1",
      avatar: "a1",
      username: "user1",
      name: "User One",
      bio: "",
      followed: [],
      status: 1,
    },
    {
      _id: "u2",
      avatar: "a2",
      username: "user2",
      name: "User Two",
      bio: "hello",
      followed: ["u1"],
      status: 1,
    },
  ];
  const result = users.map((u) => stripEmptyOptionalFields(u, REQUIRED_USER_FIELDS));
  assert.equal(result[0].followed, undefined);
  assert.equal(result[0].bio, ""); // required field
  assert.deepEqual(result[1].followed, ["u1"]);
  assert.equal(result[1].bio, "hello");
});

