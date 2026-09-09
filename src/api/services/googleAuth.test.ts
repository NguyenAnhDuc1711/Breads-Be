import assert from "node:assert/strict";
import { test } from "node:test";
import { OAuth2Client } from "google-auth-library";
import {
  GoogleAuthConfigError,
  GoogleTokenError,
  verifyGoogleIdToken,
} from "./googleAuth.ts";

const CLIENT_ID = "test-client-id.apps.example.com";

/**
 * Không gọi Google thật: thay verifyIdToken trên prototype của OAuth2Client.
 * Trả về số lần đã gọi để test #5 khẳng định "không hề được gọi".
 */
const stubVerifyIdToken = (impl) => {
  const original = OAuth2Client.prototype.verifyIdToken;
  const calls = { count: 0 };
  OAuth2Client.prototype.verifyIdToken = async function (options) {
    calls.count += 1;
    return impl(options);
  };
  return {
    calls,
    restore: () => {
      OAuth2Client.prototype.verifyIdToken = original;
    },
  };
};

const withClientId = (value) => {
  const original = process.env.GOOGLE_CLIENT_ID;
  if (value === undefined) delete process.env.GOOGLE_CLIENT_ID;
  else process.env.GOOGLE_CLIENT_ID = value;
  return () => {
    if (original === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = original;
  };
};

/** Message y hệt thư viện google-auth-library ném ra cho từng nguyên nhân. */
const LIB_ERRORS = {
  signature: "Invalid token signature: header.payload.forged",
  issuer:
    "Invalid issuer, expected one of [accounts.google.com, https://accounts.google.com], but got https://evil.example.com",
  audience: "Wrong recipient, payload audience != requiredAudience",
  expired: "Token used too late, 1700000000 > 1699999999",
};

const rejectsWithCode = async (libMessage, expectedCode) => {
  const restoreEnv = withClientId(CLIENT_ID);
  const stub = stubVerifyIdToken(() => {
    throw new Error(libMessage);
  });
  try {
    await assert.rejects(
      () => verifyGoogleIdToken("any-token"),
      (err) => {
        assert.ok(err instanceof GoogleTokenError);
        assert.equal(err.code, expectedCode);
        assert.equal(err.statusCode, 401);
        return true;
      },
    );
    assert.equal(stub.calls.count, 1);
  } finally {
    stub.restore();
    restoreEnv();
  }
};

test("FR-2.1: token chữ ký sai -> ném lỗi phân loại 'signature'", async () => {
  await rejectsWithCode(LIB_ERRORS.signature, "signature");
});

test("FR-2.2: token iss sai -> ném lỗi phân loại 'issuer'", async () => {
  await rejectsWithCode(LIB_ERRORS.issuer, "issuer");
});

test("FR-2.3: token aud của ứng dụng khác -> ném lỗi phân loại 'audience'", async () => {
  await rejectsWithCode(LIB_ERRORS.audience, "audience");
});

test("FR-2.4: token hết hạn -> ném lỗi phân loại 'expired'", async () => {
  await rejectsWithCode(LIB_ERRORS.expired, "expired");
});

test("CRIT-3: GOOGLE_CLIENT_ID rỗng -> lỗi cấu hình VÀ verifyIdToken không hề được gọi", async () => {
  for (const value of [undefined, "", "   "]) {
    const restoreEnv = withClientId(value);
    const stub = stubVerifyIdToken(() => {
      throw new Error("verifyIdToken không được phép chạy khi thiếu env");
    });
    try {
      await assert.rejects(
        () => verifyGoogleIdToken("any-token"),
        (err) => {
          assert.ok(err instanceof GoogleAuthConfigError);
          assert.equal(err.statusCode, 500);
          return true;
        },
      );
      // Bằng chứng duy nhất cho CRIT-3: audience rỗng không lọt xuống thư viện.
      assert.equal(stub.calls.count, 0);
    } finally {
      stub.restore();
      restoreEnv();
    }
  }
});

test("happy path: token hợp lệ -> trả đúng các trường từ payload đã xác thực", async () => {
  const restoreEnv = withClientId(CLIENT_ID);
  const payload = {
    sub: "1234567890",
    email: "user@example.com",
    email_verified: true,
    name: "Test User",
    picture: "https://lh3.googleusercontent.com/a/photo",
  };
  const stub = stubVerifyIdToken((options) => {
    assert.equal(options.audience, CLIENT_ID);
    assert.equal(options.idToken, "valid-token");
    return { getPayload: () => payload };
  });
  try {
    assert.deepEqual(await verifyGoogleIdToken("valid-token"), {
      sub: "1234567890",
      email: "user@example.com",
      emailVerified: true,
      name: "Test User",
      picture: "https://lh3.googleusercontent.com/a/photo",
    });
  } finally {
    stub.restore();
    restoreEnv();
  }
});

test("edge case: payload rỗng -> ném lỗi xác thực", async () => {
  const restoreEnv = withClientId(CLIENT_ID);
  const stub = stubVerifyIdToken(() => ({ getPayload: () => undefined }));
  try {
    await assert.rejects(
      () => verifyGoogleIdToken("valid-token"),
      (err) => {
        assert.ok(err instanceof GoogleTokenError);
        assert.equal(err.code, "invalid");
        return true;
      },
    );
  } finally {
    stub.restore();
    restoreEnv();
  }
});
