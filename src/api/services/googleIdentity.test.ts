import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GOOGLE_IDENTITY_CONFLICT_REASON,
  resolveGoogleIdentity,
} from "./googleIdentity.ts";

const SUB = "google-sub-111";
const EMAIL = "someone@example.com";

/**
 * Model giả ghi lại mọi filter đã tra để test khẳng định được thứ tự tra cứu
 * (và khẳng định nhánh "login" KHÔNG hề tra theo email).
 */
const fakeUserModel = (docs: any[]) => {
  const queries: any[] = [];
  return {
    queries,
    findOne: async (filter: any) => {
      queries.push(filter);
      if ("googleId" in filter) {
        return docs.find((d) => d.googleId === filter.googleId) ?? null;
      }
      if ("email" in filter) {
        return docs.find((d) => d.email === filter.email) ?? null;
      }
      return null;
    },
  };
};

test("#1 tổ hợp 1: không khớp googleId lẫn email -> action=create", async () => {
  const model = fakeUserModel([]);
  const result = await resolveGoogleIdentity({ sub: SUB, email: EMAIL }, model);

  assert.equal(result.action, "create");
  assert.equal(model.queries.length, 2, "phải tra cả googleId rồi mới tra email");
});

test("#2 tổ hợp 2: email khớp user chưa có googleId -> action=link, đúng user", async () => {
  const existing = { _id: "u1", email: EMAIL, googleId: undefined };
  const model = fakeUserModel([existing]);

  const result = await resolveGoogleIdentity({ sub: SUB, email: EMAIL }, model);

  assert.equal(result.action, "link");
  assert.equal((result as any).user, existing);
});

test("#3 tổ hợp 3: googleId khớp -> action=login và KHÔNG tra theo email", async () => {
  const existing = { _id: "u1", email: EMAIL, googleId: SUB };
  const model = fakeUserModel([existing]);

  const result = await resolveGoogleIdentity({ sub: SUB, email: EMAIL }, model);

  assert.equal(result.action, "login");
  assert.equal((result as any).user, existing);
  assert.deepEqual(
    model.queries,
    [{ googleId: SUB }],
    "khớp googleId thì phải dừng ngay, không được tra email",
  );
});

test("#4 tổ hợp 4: email khớp user đã gắn googleId KHÁC -> action=reject", async () => {
  const existing = { _id: "u1", email: EMAIL, googleId: "google-sub-OTHER" };
  const model = fakeUserModel([existing]);

  const result = await resolveGoogleIdentity({ sub: SUB, email: EMAIL }, model);

  assert.equal(
    result.action,
    "reject",
    "ghi đè googleId ở đây = cho phép chiếm tài khoản",
  );
  assert.equal((result as any).reason, GOOGLE_IDENTITY_CONFLICT_REASON);
});

test("#5 đổi email Google: googleId khớp user A, email khớp user B -> trả user A", async () => {
  const userA = { _id: "A", email: "old@example.com", googleId: SUB };
  const userB = { _id: "B", email: EMAIL, googleId: undefined };
  const model = fakeUserModel([userA, userB]);

  const result = await resolveGoogleIdentity({ sub: SUB, email: EMAIL }, model);

  assert.equal(result.action, "login");
  assert.equal(
    (result as any).user._id,
    "A",
    "googleId là định danh bền, phải thắng kết quả tra email",
  );
});
