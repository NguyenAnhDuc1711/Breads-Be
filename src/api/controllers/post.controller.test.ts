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
import { isRepostLikePayload, updatePost, validateRepostGuard } from "./post.controller.ts";
import { closeFanoutQueues } from "../services/feed/queue.ts";
import Post from "../models/post.model.ts";
import { updatePostSchema } from "../validators/post.validator.ts";

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

after(async () => {
  await closeFanoutQueues();
});
