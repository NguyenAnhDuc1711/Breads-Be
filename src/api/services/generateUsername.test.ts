import assert from "node:assert/strict";
import { test } from "node:test";
import {
  generateUsernameFromEmail,
  usernameCandidateAt,
  writeWithUsernameRetry,
} from "./user.ts";

const USERNAME_PATTERN = /^[a-z0-9._-]{3,30}$/;

test("generateUsernameFromEmail: trường hợp thường", () => {
  assert.equal(generateUsernameFromEmail("NguyenVanA@gmail.com"), "nguyenvana");
});

test("generateUsernameFromEmail: ký tự lạ bị loại bỏ (không thay thế)", () => {
  const result = generateUsernameFromEmail("ng.uyen+tag@gmail.com");
  assert.match(result, USERNAME_PATTERN);
  assert.ok(!result.includes("+"));
  assert.equal(result, "ng.uyentag");
});

test("usernameCandidateAt: lần thử 1 và 2 thêm hậu tố số", () => {
  assert.equal(usernameCandidateAt("nguyenvana", 1), "nguyenvana1");
  assert.equal(usernameCandidateAt("nguyenvana", 2), "nguyenvana2");
});

test("usernameCandidateAt: không vượt 30 ký tự khi base đã dài tối đa", () => {
  const base = "a".repeat(30);
  const candidate = usernameCandidateAt(base, 3);
  assert.ok(candidate.length <= 30);
  assert.equal(candidate, `${"a".repeat(29)}3`);
});

test("generateUsernameFromEmail: ca degenerate '+++@gmail.com'", () => {
  const result = generateUsernameFromEmail("+++@gmail.com");
  assert.match(result, USERNAME_PATTERN);
  assert.ok(result.length >= 3);
});

test("generateUsernameFromEmail: ca degenerate '...@gmail.com'", () => {
  const result = generateUsernameFromEmail("...@gmail.com");
  assert.match(result, USERNAME_PATTERN);
});

test("writeWithUsernameRetry: đụng E11000 username 2 lần rồi thành công", async () => {
  let calls = 0;
  const result = await writeWithUsernameRetry("nguyenvana", async (candidate) => {
    calls++;
    if (calls <= 2) {
      const err = new Error("E11000 duplicate key error");
      err.code = 11000;
      err.keyPattern = { username: 1 };
      throw err;
    }
    return candidate;
  });
  assert.equal(calls, 3);
  assert.equal(result, "nguyenvana2");
});

test("writeWithUsernameRetry: hết lượt thử thì ném lỗi có nghĩa, không lặp vô hạn", async () => {
  let calls = 0;
  await assert.rejects(
    writeWithUsernameRetry("nguyenvana", async () => {
      calls++;
      const err = new Error("E11000 duplicate key error");
      err.code = 11000;
      err.keyPattern = { username: 1 };
      throw err;
    }),
    /hết 5 lần thử/
  );
  assert.equal(calls, 5);
});

test("writeWithUsernameRetry: E11000 trên email không bị retry, ném nguyên vẹn", async () => {
  let calls = 0;
  const emailDupErr = new Error("E11000 duplicate key error");
  emailDupErr.code = 11000;
  emailDupErr.keyPattern = { email: 1 };

  await assert.rejects(
    writeWithUsernameRetry("nguyenvana", async () => {
      calls++;
      throw emailDupErr;
    }),
    (err) => err === emailDupErr
  );
  assert.equal(calls, 1);
});
