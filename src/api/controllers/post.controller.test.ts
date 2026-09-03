import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Constants } from "../../Breads-Shared/Constants/index.js";
import PostConstants from "../../Breads-Shared/Constants/PostConstants.js";
import {
  createPost,
  getSitemapEligiblePosts,
  isRepostLikePayload,
  processNewPostMediaItem,
  updatePost,
  validateRepostGuard,
} from "./post.controller.ts";
import { closeFanoutQueues } from "../services/feed/queue.ts";
import Post from "../models/post.model.ts";
import User from "../models/user.model.ts";
import { updatePostSchema } from "../validators/post.validator.ts";

const CLOUD_NAME = "demo-cloud";
const withCloudName = async (fn: () => Promise<void> | void) => {
  process.env.CLOUDINARY_CLOUD_NAME = CLOUD_NAME;
  try {
    await fn();
  } finally {
    delete process.env.CLOUDINARY_CLOUD_NAME;
  }
};

const { PUBLIC, ONLY_FOLLOWERS, ONLY_ME } = Constants.POST_VISIBILITY;

test("isRepostLikePayload: action=repost -> true", () => {
  assert.equal(
    isRepostLikePayload({ action: PostConstants.ACTIONS.REPOST }),
    true,
  );
});

test("isRepostLikePayload: type=REPOST (không có action) -> true", () => {
  assert.equal(
    isRepostLikePayload({ type: PostConstants.ACTIONS.REPOST }),
    true,
  );
});

test("isRepostLikePayload regression (Task 090 bypass): quote._id thủ công, không action/type -> true", () => {
  assert.equal(
    isRepostLikePayload({
      type: PostConstants.ACTIONS.CREATE,
      quote: { _id: "652f1b2c3d4e5f6071829304" },
    }),
    true,
  );
});

test("isRepostLikePayload: bài viết thường (không quote, không repost) -> false", () => {
  assert.equal(isRepostLikePayload({ type: PostConstants.ACTIONS.CREATE }), false);
  assert.equal(
    isRepostLikePayload({ type: PostConstants.ACTIONS.CREATE, quote: {} }),
    false,
  );
  assert.equal(
    isRepostLikePayload({ type: PostConstants.ACTIONS.CREATE, quote: undefined }),
    false,
  );
});

test("validateRepostGuard: bài tham chiếu không tồn tại -> lỗi rõ ràng, không crash", () => {
  const result = validateRepostGuard(null);
  assert.equal(result.ok, false);
  assert.equal((result as any).error, "Parent post not found");
});

test("validateRepostGuard: bài tham chiếu visibility != PUBLIC -> chặn", () => {
  for (const visibility of [ONLY_FOLLOWERS, ONLY_ME]) {
    const result = validateRepostGuard({ visibility });
    assert.equal(result.ok, false);
    assert.equal((result as any).error, "Cannot repost non-public content");
  }
});

test("validateRepostGuard: bài tham chiếu visibility=PUBLIC -> cho phép", () => {
  assert.deepEqual(validateRepostGuard({ visibility: PUBLIC }), { ok: true });
});

test("FAIL-1 (CRITICAL, end-to-end): updatePost content vắng mặt -> content KHÔNG bị ghi đè thành ''", async () => {
  const VALID_ID = "652f1b2c3d4e5f6071829304";
  const AUTHOR_ID = "652f1b2c3d4e5f6071829305";
  const existingContent = "Nội dung gốc, không được ghi đè";

  const parsedBody: any = updatePostSchema.body.parse({
    _id: VALID_ID,
    userId: AUTHOR_ID,
    survey: [],
  });
  assert.equal(
    Object.prototype.hasOwnProperty.call(parsedBody, "content"),
    false,
    "precondition: content phải vắng mặt sau parse (guard hoạt động đúng)"
  );

  const fakePost: any = {
    _id: VALID_ID,
    authorId: { toString: () => AUTHOR_ID },
    content: existingContent,
    media: ["old-media"],
    survey: ["old-survey-id"],
    save: async function () {
      return this;
    },
  };
  const originalFindById = (Post as any).findById;
  (Post as any).findById = async () => fakePost;

  const res: any = {
    status(code: number) {
      this._status = code;
      return this;
    },
    json(body: any) {
      this._body = body;
      return this;
    },
  };

  try {
    await updatePost({ body: parsedBody, params: { id: VALID_ID }, user: { _id: AUTHOR_ID } }, res);

    assert.equal(res._status, 200, "request hợp lệ phải thành công");
    assert.notEqual(
      fakePost.content,
      "",
      "CRITICAL: content không được trở thành '' — đây chính xác là bug FAIL-1 nếu thiếu guard"
    );
  } finally {
    (Post as any).findById = originalFindById;
  }
});

const AUTHOR_ID = "652f1b2c3d4e5f6071829305";

test("FR-5 scenario (createPost, hợp lệ): URL Cloudinary đúng authorId -> được chấp nhận", async () => {
  await withCloudName(async () => {
    const url = `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/v1700000000/post/${AUTHOR_ID}/507f1f77bcf86cd799439011.jpg`;
    const item = { url, type: Constants.MEDIA_TYPE.IMAGE };
    const result = await processNewPostMediaItem(item, AUTHOR_ID);
    assert.deepEqual(result, item);
  });
});

test("FR-5 scenario (createPost, GIF): item type=gif với URL NGOÀI Cloudinary -> được chấp nhận, bỏ qua validate (AD-4)", async () => {
  await withCloudName(async () => {
    const item = {
      url: "https://media.giphy.com/media/l3vR85PnGsBwu1PFK/giphy.gif",
      type: Constants.MEDIA_TYPE.GIF,
    };
    const result = await processNewPostMediaItem(item, AUTHOR_ID);
    assert.deepEqual(result, item);
  });
});

test("FR-5 scenario (createPost, URL không hợp lệ): sai authorId prefix -> reject (null)", async () => {
  await withCloudName(async () => {
    const otherAuthorId = "652f1b2c3d4e5f6071829399";
    const url = `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/v1700000000/post/${otherAuthorId}/507f1f77bcf86cd799439011.jpg`;
    const result = await processNewPostMediaItem(
      { url, type: Constants.MEDIA_TYPE.IMAGE },
      AUTHOR_ID,
    );
    assert.equal(result, null);
  });
});

test("FR-5 scenario (createPost, URL không hợp lệ): sai domain (không phải Cloudinary) -> reject (null)", async () => {
  await withCloudName(async () => {
    const result = await processNewPostMediaItem(
      { url: "https://evil-host.com/post/" + AUTHOR_ID + "/x.jpg", type: Constants.MEDIA_TYPE.IMAGE },
      AUTHOR_ID,
    );
    assert.equal(result, null);
  });
});

const buildCreatePostReq = (media: any[]) => ({
  query: {},
  user: { _id: AUTHOR_ID },
  body: {
    authorId: "6a0000000000000000000001",
    content: "",
    media,
    survey: [],
    usersTag: [],
    links: [],
    files: [],
    quote: undefined,
    parentPost: undefined,
    type: PostConstants.ACTIONS.CREATE,
  },
});

const buildRes = () => ({
  status(code: number) {
    this._status = code;
    return this;
  },
  json(body: any) {
    this._body = body;
    return this;
  },
} as any);

test("FR-5 (createPost end-to-end, AC3): item media mới KHÔNG hợp lệ -> 400, không chạm Post.save", async () => {
  await withCloudName(async () => {
    const invalidUrl = "https://evil-host.com/not-cloudinary.jpg";
    const req = buildCreatePostReq([{ url: invalidUrl, type: Constants.MEDIA_TYPE.IMAGE }]);
    const res = buildRes();

    const originalFindById = (User as any).findById;
    (User as any).findById = async () => ({ _id: AUTHOR_ID });
    let saveCalled = false;
    const originalSave = (Post as any).prototype.save;
    (Post as any).prototype.save = async function () {
      saveCalled = true;
      return this;
    };

    try {
      await assert.rejects(createPost(req, res), /Invalid media URL/);
      assert.equal(saveCalled, false, "reject phải xảy ra TRƯỚC khi lưu post");
    } finally {
      (User as any).findById = originalFindById;
      (Post as any).prototype.save = originalSave;
    }
  });
});

test("FR-5 (createPost end-to-end, AC1): item media hợp lệ đúng authorId -> qua được validate, tới bước lưu", async () => {
  await withCloudName(async () => {
    const validUrl = `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/v1700000000/post/${AUTHOR_ID}/507f1f77bcf86cd799439011.jpg`;
    const req = buildCreatePostReq([{ url: validUrl, type: Constants.MEDIA_TYPE.IMAGE }]);
    const res = buildRes();

    const originalFindById = (User as any).findById;
    (User as any).findById = async () => ({ _id: AUTHOR_ID });
    const originalSave = (Post as any).prototype.save;
    (Post as any).prototype.save = async function () {
      throw new Error("REACHED_SAVE");
    };

    try {
      await assert.rejects(createPost(req, res), /REACHED_SAVE/);
    } finally {
      (User as any).findById = originalFindById;
      (Post as any).prototype.save = originalSave;
    }
  });
});

test("FR-5 (createPost end-to-end, AC2): item media GIF ngoài Cloudinary -> qua được validate (carve-out), tới bước lưu", async () => {
  await withCloudName(async () => {
    const req = buildCreatePostReq([
      { url: "https://media.giphy.com/media/l3vR85PnGsBwu1PFK/giphy.gif", type: Constants.MEDIA_TYPE.GIF },
    ]);
    const res = buildRes();

    const originalFindById = (User as any).findById;
    (User as any).findById = async () => ({ _id: AUTHOR_ID });
    const originalSave = (Post as any).prototype.save;
    (Post as any).prototype.save = async function () {
      throw new Error("REACHED_SAVE");
    };

    try {
      await assert.rejects(createPost(req, res), /REACHED_SAVE/);
    } finally {
      (User as any).findById = originalFindById;
      (Post as any).prototype.save = originalSave;
    }
  });
});

const buildFakePost = (media: any[]) => ({
  _id: "652f1b2c3d4e5f6071829304",
  authorId: { toString: () => AUTHOR_ID },
  content: "existing content",
  media,
  survey: [],
  save: async function () {
    return this;
  },
});

const stubPostFindById = (fakePost: any) => {
  const original = (Post as any).findById;
  (Post as any).findById = async () => fakePost;
  return () => {
    (Post as any).findById = original;
  };
};

test("FR-5 scenario (updatePost, giữ media cũ): URL cũ KHÔNG đúng convention mới vẫn giữ nguyên, không bị reject", async () => {
  await withCloudName(async () => {
    const legacyUrl = "https://res.cloudinary.com/" + CLOUD_NAME + "/image/upload/legacy/old-photo.jpg";
    const fakePost = buildFakePost([{ url: legacyUrl, type: Constants.MEDIA_TYPE.IMAGE }]);
    const restore = stubPostFindById(fakePost);

    const parsedBody: any = updatePostSchema.body.parse({
      _id: fakePost._id,
      userId: AUTHOR_ID,
      media: [{ url: legacyUrl, type: Constants.MEDIA_TYPE.IMAGE }],
      survey: [],
    });
    const res = buildRes();

    try {
      await updatePost({ body: parsedBody, params: { id: fakePost._id }, user: { _id: AUTHOR_ID } }, res);
      assert.equal(res._status, 200);
      assert.deepEqual(fakePost.media, [{ url: legacyUrl, type: Constants.MEDIA_TYPE.IMAGE }]);
    } finally {
      restore();
    }
  });
});

test("FR-5 scenario (updatePost, thêm media mới hợp lệ): item cũ giữ nguyên không validate lại, item mới hợp lệ được chấp nhận", async () => {
  await withCloudName(async () => {
    const legacyUrl = "https://res.cloudinary.com/" + CLOUD_NAME + "/image/upload/legacy/old-photo.jpg";
    const newValidUrl = `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/v1700000000/post/${AUTHOR_ID}/507f1f77bcf86cd799439099.jpg`;
    const fakePost = buildFakePost([{ url: legacyUrl, type: Constants.MEDIA_TYPE.IMAGE }]);
    const restore = stubPostFindById(fakePost);

    const parsedBody: any = updatePostSchema.body.parse({
      _id: fakePost._id,
      userId: AUTHOR_ID,
      media: [
        { url: legacyUrl, type: Constants.MEDIA_TYPE.IMAGE },
        { url: newValidUrl, type: Constants.MEDIA_TYPE.IMAGE },
      ],
      survey: [],
    });
    const res = buildRes();

    try {
      await updatePost({ body: parsedBody, params: { id: fakePost._id }, user: { _id: AUTHOR_ID } }, res);
      assert.equal(res._status, 200);
      assert.deepEqual(fakePost.media, [
        { url: legacyUrl, type: Constants.MEDIA_TYPE.IMAGE },
        { url: newValidUrl, type: Constants.MEDIA_TYPE.IMAGE },
      ]);
    } finally {
      restore();
    }
  });
});

test("FR-5 scenario (updatePost, thêm media mới KHÔNG hợp lệ): chỉ item mới bị reject, item cũ không bị ảnh hưởng/lưu", async () => {
  await withCloudName(async () => {
    const legacyUrl = "https://res.cloudinary.com/" + CLOUD_NAME + "/image/upload/legacy/old-photo.jpg";
    const invalidNewUrl = "https://evil-host.com/not-cloudinary.jpg";
    const fakePost = buildFakePost([{ url: legacyUrl, type: Constants.MEDIA_TYPE.IMAGE }]);
    const restore = stubPostFindById(fakePost);
    let saveCalled = false;
    fakePost.save = async function () {
      saveCalled = true;
      return this;
    };

    const parsedBody: any = updatePostSchema.body.parse({
      _id: fakePost._id,
      userId: AUTHOR_ID,
      media: [
        { url: legacyUrl, type: Constants.MEDIA_TYPE.IMAGE },
        { url: invalidNewUrl, type: Constants.MEDIA_TYPE.IMAGE },
      ],
      survey: [],
    });
    const res = buildRes();

    try {
      await assert.rejects(
        updatePost({ body: parsedBody, params: { id: fakePost._id }, user: { _id: AUTHOR_ID } }, res),
        /Invalid media URL/,
      );
      assert.equal(saveCalled, false, "reject phải xảy ra TRƯỚC khi lưu post");
      assert.deepEqual(fakePost.media, [{ url: legacyUrl, type: Constants.MEDIA_TYPE.IMAGE }]);
    } finally {
      restore();
    }
  });
});

test("Task 011 Tests to Write #2: updatePost với post.media=[] (rỗng) -> diff không crash, item mới hợp lệ được chấp nhận", async () => {
  await withCloudName(async () => {
    const newValidUrl = `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/v1700000000/post/${AUTHOR_ID}/507f1f77bcf86cd799439088.jpg`;
    const fakePost = buildFakePost([]);
    const restore = stubPostFindById(fakePost);

    const parsedBody: any = updatePostSchema.body.parse({
      _id: fakePost._id,
      userId: AUTHOR_ID,
      media: [{ url: newValidUrl, type: Constants.MEDIA_TYPE.IMAGE }],
      survey: [],
    });
    const res = buildRes();

    try {
      await updatePost({ body: parsedBody, params: { id: fakePost._id }, user: { _id: AUTHOR_ID } }, res);
      assert.equal(res._status, 200);
      assert.deepEqual(fakePost.media, [{ url: newValidUrl, type: Constants.MEDIA_TYPE.IMAGE }]);
    } finally {
      restore();
    }
  });
});

test("Task 011 Tests to Write #3: updatePost với item media mới type=gif (URL ngoài Cloudinary) -> chấp nhận, không lẫn với test ảnh thường", async () => {
  await withCloudName(async () => {
    const gifUrl = "https://media.giphy.com/media/l3vR85PnGsBwu1PFK/giphy.gif";
    const fakePost = buildFakePost([]);
    const restore = stubPostFindById(fakePost);

    const parsedBody: any = updatePostSchema.body.parse({
      _id: fakePost._id,
      userId: AUTHOR_ID,
      media: [{ url: gifUrl, type: Constants.MEDIA_TYPE.GIF }],
      survey: [],
    });
    const res = buildRes();

    try {
      await updatePost({ body: parsedBody, params: { id: fakePost._id }, user: { _id: AUTHOR_ID } }, res);
      assert.equal(res._status, 200);
      assert.deepEqual(fakePost.media, [{ url: gifUrl, type: Constants.MEDIA_TYPE.GIF }]);
    } finally {
      restore();
    }
  });
});

test("FR-1: filter đúng CẢ 3 điều kiện (status=PUBLIC, visibility=PUBLIC, engagementScore>=5); totalCount khớp countDocuments độc lập", async () => {
  const capturedFindFilter: any[] = [];
  const capturedCountFilter: any[] = [];
  const fakeDocs = [
    { _id: "000000000000000000000001", updatedAt: new Date("2024-01-01"), engagementScore: 5 },
    { _id: "000000000000000000000002", updatedAt: new Date("2024-01-02"), engagementScore: 9 },
  ];

  const originalFind = (Post as any).find;
  const originalCountDocuments = (Post as any).countDocuments;
  (Post as any).find = (filter: any) => {
    capturedFindFilter.push(filter);
    return {
      sort() {
        return this;
      },
      limit() {
        return this;
      },
      select() {
        return this;
      },
      lean: async () => fakeDocs,
    };
  };
  (Post as any).countDocuments = async (filter: any) => {
    capturedCountFilter.push(filter);
    return fakeDocs.length;
  };

  const res = buildRes();
  try {
    await getSitemapEligiblePosts({ query: { limit: 1000 } } as any, res);

    const expectedFilter = {
      status: Constants.POST_STATUS.PUBLIC,
      visibility: Constants.POST_VISIBILITY.PUBLIC,
      engagementScore: { $gte: 5 },
    };
    assert.deepEqual(
      capturedFindFilter[0],
      expectedFilter,
      "Post.find phải nhận đúng 3 điều kiện — không lẫn PRE_ACCEPT hay visibility khác PUBLIC",
    );
    assert.deepEqual(
      capturedCountFilter[0],
      expectedFilter,
      "Post.countDocuments phải dùng CÙNG filter với Post.find (totalCount phải khớp nghĩa với data)",
    );
    assert.equal(res._status, 200);
    assert.equal(
      res._body.metadata.totalCount,
      fakeDocs.length,
      "totalCount phải khớp với countDocuments độc lập, không phải số cứng trong controller",
    );
    assert.deepEqual(
      res._body.metadata.data.map((d: any) => d.postId),
      fakeDocs.map((d) => d._id),
    );
  } finally {
    (Post as any).find = originalFind;
    (Post as any).countDocuments = originalCountDocuments;
  }
});

test("FR-1: có cursor -> totalCount=null và KHÔNG gọi countDocuments (tránh tính lại mỗi trang)", async () => {
  const originalFind = (Post as any).find;
  const originalCountDocuments = (Post as any).countDocuments;
  let countCalled = false;

  (Post as any).find = () => ({
    sort() {
      return this;
    },
    limit() {
      return this;
    },
    select() {
      return this;
    },
    lean: async () => [],
  });
  (Post as any).countDocuments = async () => {
    countCalled = true;
    return 999;
  };

  const res = buildRes();
  try {
    await getSitemapEligiblePosts(
      { query: { cursor: "000000000000000000000005", limit: 1000 } } as any,
      res,
    );
    assert.equal(res._body.metadata.totalCount, null);
    assert.equal(countCalled, false);
  } finally {
    (Post as any).find = originalFind;
    (Post as any).countDocuments = originalCountDocuments;
  }
});

after(async () => {
  await closeFanoutQueues();
});
