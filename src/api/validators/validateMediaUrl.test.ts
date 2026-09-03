import assert from "node:assert/strict";
import { test } from "node:test";
import { validateMediaUrl } from "./validateMediaUrl.ts";

const CLOUD_NAME = "demo-cloud";

const withCloudName = (fn: () => void) => {
  process.env.CLOUDINARY_CLOUD_NAME = CLOUD_NAME;
  try {
    fn();
  } finally {
    delete process.env.CLOUDINARY_CLOUD_NAME;
  }
};

test("validateMediaUrl:message/strict: domain + public_id + expectedKey (sortedPairId) đều khớp -> true", () => {
  withCloudName(() => {
    const url = `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/v1700000000/message/A_B/507f1f77bcf86cd799439011.jpg`;
    assert.equal(
      validateMediaUrl(url, { namespace: "message", expectedKey: "A_B" }),
      true,
    );
  });
});

test("validateMediaUrl:message/strict: sai domain (không phải Cloudinary) -> false", () => {
  withCloudName(() => {
    const url = `https://evil-host.com/${CLOUD_NAME}/image/upload/message/A_B/507f1f77bcf86cd799439011.jpg`;
    assert.equal(
      validateMediaUrl(url, { namespace: "message", expectedKey: "A_B" }),
      false,
    );
  });
});

test("validateMediaUrl:message/strict: đúng shape Cloudinary nhưng khác cloud_name (account khác) -> false", () => {
  withCloudName(() => {
    const url = `https://res.cloudinary.com/other-cloud/image/upload/message/A_B/507f1f77bcf86cd799439011.jpg`;
    assert.equal(
      validateMediaUrl(url, { namespace: "message", expectedKey: "A_B" }),
      false,
    );
  });
});

test("validateMediaUrl:message/strict: sai key (sortedPairId không khớp expectedKey, vd. cặp user khác) -> false", () => {
  withCloudName(() => {
    const url = `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/message/A_B/507f1f77bcf86cd799439011.jpg`;
    assert.equal(
      validateMediaUrl(url, { namespace: "message", expectedKey: "C_D" }),
      false,
    );
  });
});

test("validateMediaUrl:message/strict: namespace không khớp (URL post nhưng validate namespace message) -> false", () => {
  withCloudName(() => {
    const url = `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/post/U/507f1f77bcf86cd799439011.jpg`;
    assert.equal(
      validateMediaUrl(url, { namespace: "message", expectedKey: "U" }),
      false,
    );
  });
});

test("validateMediaUrl:message/loose: không truyền expectedKey -> chỉ cần đúng namespace", () => {
  withCloudName(() => {
    const url = `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/message/A_B/507f1f77bcf86cd799439011.jpg`;
    assert.equal(validateMediaUrl(url, { namespace: "message" }), true);
  });
});

test("validateMediaUrl:post/strict: domain + public_id + expectedKey (authorId) đều khớp -> true", () => {
  withCloudName(() => {
    const url = `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/v1700000000/post/U1/507f1f77bcf86cd799439011.jpg`;
    assert.equal(
      validateMediaUrl(url, { namespace: "post", expectedKey: "U1" }),
      true,
    );
  });
});

test("validateMediaUrl:post/strict: sai domain (không phải Cloudinary) -> false", () => {
  withCloudName(() => {
    const url = `https://evil-host.com/${CLOUD_NAME}/image/upload/post/U1/507f1f77bcf86cd799439011.jpg`;
    assert.equal(
      validateMediaUrl(url, { namespace: "post", expectedKey: "U1" }),
      false,
    );
  });
});

test("validateMediaUrl:post/strict: đúng shape Cloudinary nhưng khác cloud_name (account khác) -> false", () => {
  withCloudName(() => {
    const url = `https://res.cloudinary.com/other-cloud/image/upload/post/U1/507f1f77bcf86cd799439011.jpg`;
    assert.equal(
      validateMediaUrl(url, { namespace: "post", expectedKey: "U1" }),
      false,
    );
  });
});

test("validateMediaUrl:post/strict: sai key (authorId không khớp expectedKey, vd. author khác) -> false", () => {
  withCloudName(() => {
    const url = `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/post/U1/507f1f77bcf86cd799439011.jpg`;
    assert.equal(
      validateMediaUrl(url, { namespace: "post", expectedKey: "U2" }),
      false,
    );
  });
});

test("validateMediaUrl:post/strict: namespace không khớp (URL message nhưng validate namespace post) -> false", () => {
  withCloudName(() => {
    const url = `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/message/A_B/507f1f77bcf86cd799439011.jpg`;
    assert.equal(
      validateMediaUrl(url, { namespace: "post", expectedKey: "A_B" }),
      false,
    );
  });
});

test("validateMediaUrl:post/loose: không truyền expectedKey -> chỉ cần đúng namespace", () => {
  withCloudName(() => {
    const url = `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/post/U1/507f1f77bcf86cd799439011.jpg`;
    assert.equal(validateMediaUrl(url, { namespace: "post" }), true);
  });
});

test("validateMediaUrl:data: base64 URI -> false (không throw)", () => {
  withCloudName(() => {
    const url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA";
    assert.doesNotThrow(() => {
      assert.equal(validateMediaUrl(url, { namespace: "message" }), false);
    });
  });
});

test("validateMediaUrl:URL host ngoài (Unsplash/GIF-host) -> false (không throw)", () => {
  withCloudName(() => {
    const url = "https://images.unsplash.com/photo-1500000000000";
    assert.doesNotThrow(() => {
      assert.equal(validateMediaUrl(url, { namespace: "post" }), false);
    });
  });
});

test("validateMediaUrl:url rỗng/null/undefined -> false, không throw", () => {
  withCloudName(() => {
    assert.doesNotThrow(() => {
      assert.equal(validateMediaUrl("", { namespace: "message" }), false);
      assert.equal(validateMediaUrl(null, { namespace: "message" }), false);
      assert.equal(validateMediaUrl(undefined, { namespace: "post" }), false);
    });
  });
});

test("validateMediaUrl:url cực dài (giả lập tấn công) -> vẫn xử lý đúng, không crash", () => {
  withCloudName(() => {
    const longGarbage = `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/` + "a".repeat(200_000);
    assert.doesNotThrow(() => {
      assert.equal(validateMediaUrl(longGarbage, { namespace: "message" }), false);
    });

    const longButValid =
      `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/v1700000000/` +
      "x".repeat(100_000) +
      "/message/A_B/507f1f77bcf86cd799439011.jpg";
    assert.doesNotThrow(() => {
      assert.equal(
        validateMediaUrl(longButValid, { namespace: "message", expectedKey: "A_B" }),
        true,
      );
    });
  });
});

test("validateMediaUrl:CLOUDINARY_CLOUD_NAME không cấu hình (env thiếu) -> false, không throw", () => {
  delete process.env.CLOUDINARY_CLOUD_NAME;
  const url = "https://res.cloudinary.com/demo-cloud/image/upload/message/A_B/507f1f77bcf86cd799439011.jpg";
  assert.doesNotThrow(() => {
    assert.equal(validateMediaUrl(url, { namespace: "message", expectedKey: "A_B" }), false);
  });
});
