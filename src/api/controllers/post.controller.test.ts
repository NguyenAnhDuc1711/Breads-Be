// Run with Node's built-in test runner: `npm test`. Cùng quy ước với
// `services/postVisibility.test.ts` — test 2 hàm thuần trích ra từ guard chặn repost/quote
// trong `createPost`, không chạm DB.
//
// Phạm vi: FR-10 (chặn repost/quote bài non-PUBLIC). Đây là nơi Critical Issue #2
// (`prd-validate` vòng 2) VÀ 1 bypass thật khác (Task 090 verify — `type=CREATE` + `quote._id`
// thủ công né được guard bản gốc) đã từng xảy ra. Test này tồn tại để 2 lỗi đó không tái sinh
// một cách âm thầm nếu ai đó sửa lại `createPost` sau này (epic post-visibility, GAP-2).
//
// Task 012: `post.controller.ts` nay import `dispatchQueue` từ `queue.ts`, mở một connection
// ioredis thật ngay lúc import — phải `closeFanoutQueues()` ở `after()` để `node --test` thoát
// được, cùng lý do `queue.test.ts` đã làm (xem comment ở đó).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Constants } from "../../Breads-Shared/Constants/index.js";
import PostConstants from "../../Breads-Shared/Constants/PostConstants.js";
import {
  createPost,
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
  // Đây chính xác là payload đã bypass guard bản gốc: type=CREATE + quote thủ công, không
  // parentPost, không action=repost.
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

/* ------------------------------- Task 010, FAIL-1 (CRITICAL): updatePost content guard, end-to-end ------------------------------- */

// Bằng chứng end-to-end (không chỉ tầng schema): đẩy body ĐÃ QUA `updatePostSchema.body.parse()`
// (đúng những gì `validate()` middleware thật sẽ gán lại vào `req.body`) vào hàm `updatePost` THẬT,
// stub tầng model (`Post.findById`, `.save()`) theo đúng pattern đã dùng ở
// `post.route.test.ts:249-267` (gán đè property của object đã import, restore trong `finally`).
//
// LƯU Ý quan trọng cho người đọc sau: `post.controller.ts:392` làm `post.content = content;` VÔ
// ĐIỀU KIỆN — task 010 KHÔNG được phép sửa file này (chỉ sửa validator). Vì vậy khi `content` vắng
// mặt, `content` destructure ra `undefined`, và dòng 392 gán `post.content = undefined`. Với
// Mongoose thật, gán `undefined` lên 1 path đã có giá trị sẽ đánh dấu path đó "modified" và khi
// `.save()` sẽ sinh `$unset` (đã verify trực tiếp bằng `Model.hydrate()` + `doc.$__delta()` khi
// viết test này) — nghĩa là hành vi "field vắng mặt vẫn xóa mất content cũ" là bug CÓ THẬT, nhưng
// PRE-EXISTING ở `post.controller.ts` (không phải do transform tạo ra), và nằm NGOÀI phạm vi task
// 010 (chỉ sửa validator, cấm sửa controller). Điều task 010 chịu trách nhiệm — và test dưới đây
// verify — là: guard ngăn KHÔNG để `content` trở thành `""` (silent-overwrite-với-chuỗi-rỗng, bug
// cụ thể mà FAIL-1 cảnh báo). Nếu thiếu guard, assert `notEqual(..., "")` bên dưới sẽ fail.
test("FAIL-1 (CRITICAL, end-to-end): updatePost content vắng mặt -> content KHÔNG bị ghi đè thành ''", async () => {
  const VALID_ID = "652f1b2c3d4e5f6071829304";
  const AUTHOR_ID = "652f1b2c3d4e5f6071829305";
  const existingContent = "Nội dung gốc, không được ghi đè";

  // Body y hệt request thật KHÔNG kèm `content` (client chỉ update survey).
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
    await updatePost({ body: parsedBody }, res);

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

/* ------------------------------- Task 011 (FR-5), epic `presigned-media-upload`: cutover
   `createPost`/`updatePost` sang chỉ chấp nhận URL Cloudinary hợp lệ (validate qua flow ký ở task
   002), thay vì base64 relay (`uploadFileFromBase64`). ------------------------------- */

const AUTHOR_ID = "652f1b2c3d4e5f6071829305";

/* ---- `processNewPostMediaItem`: hàm thuần dùng chung cho 1 item media MỚI, cùng thứ tự 3-bước
   check như `sendMessage` (task 010) — GIF bỏ qua -> flag+`data:` fallback -> `validateMediaUrl`
   strict. `createPost` gọi hàm này cho MỌI item; `updatePost` chỉ gọi cho item MỚI (sau khi diff).
   Test trực tiếp hàm này để không phụ thuộc DB thật (đúng pattern `isRepostLikePayload`/
   `validateRepostGuard` đã có sẵn trong file). ---- */

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
    // Shape thật của post có GIF — xem `crawl.ts:54-84` `crawlPostsWithGif`: `media: [{url:
    // <giphy url>, type: Constants.MEDIA_TYPE.GIF}]`. URL này CỐ Ý không phải domain Cloudinary —
    // nếu carve-out GIF không hoạt động, validateMediaUrl strict sẽ reject item này (regression).
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

/* ---- `createPost` end-to-end (controller thật, stub tầng model theo đúng pattern
   `Post.findById`/`(Post as any).prototype.save` đã dùng ở FAIL-1 test bên trên). Reject case
   (AC3) dừng lại TRƯỚC khi chạm DB write nên chỉ cần stub `User.findById`. Success case (AC1/AC2)
   dùng 1 stub đánh dấu ("REACHED_SAVE") trên `Post.prototype.save` để chứng minh execution ĐÃ đi
   qua được bước validate media (không bị reject 400) và tới đúng bước lưu — không cần dựng lại
   toàn bộ pipeline `getPostDetail` (aggregate DB thật). ---- */

const buildCreatePostReq = (media: any[]) => ({
  query: {},
  body: {
    authorId: AUTHOR_ID,
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
      await createPost(req, res);
      assert.equal(res._status, 400);
      assert.match(res._body.error, /Invalid media URL/);
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

/* ---- `updatePost` end-to-end (cùng pattern stub `Post.findById`/`.save()` như FAIL-1 test) ----
   Đây là logic MỚI hoàn toàn (`updatePost` trước task 011 KHÔNG validate `media` gì cả). */

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
    // Media từ TRƯỚC epic này — không có prefix `post/{authorId}/` — nếu bị validate lại sẽ reject.
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
      await updatePost({ body: parsedBody }, res);
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
      await updatePost({ body: parsedBody }, res);
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
      await updatePost({ body: parsedBody }, res);
      assert.equal(res._status, 400);
      assert.match((res as any)._body.error, /Invalid media URL/);
      assert.equal(saveCalled, false, "reject phải xảy ra TRƯỚC khi lưu post");
      // Item cũ không bị đụng tới — `post.media` chưa từng bị gán lại khi reject giữa chừng.
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
      await updatePost({ body: parsedBody }, res);
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
      await updatePost({ body: parsedBody }, res);
      assert.equal(res._status, 200);
      assert.deepEqual(fakePost.media, [{ url: gifUrl, type: Constants.MEDIA_TYPE.GIF }]);
    } finally {
      restore();
    }
  });
});

after(async () => {
  await closeFanoutQueues();
});
