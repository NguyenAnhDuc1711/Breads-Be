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
import { isRepostLikePayload, validateRepostGuard } from "./post.controller.ts";
import { closeFanoutQueues } from "../services/feed/queue.ts";

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

after(async () => {
  await closeFanoutQueues();
});
