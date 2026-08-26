// Run with Node's built-in test runner: `npm test`.
//
// Task 011 (epic follow-suggestions, FR-3/FR-4): `getUserToFollows` read-path fix. Stubs
// model-layer methods (pattern already established in `post.controller.test.ts`) instead of
// spinning a real `mongod` — what needs verifying here is CONTROL FLOW (which branch runs, does the
// exclude-followed filter apply), not aggregation-engine semantics, so a stub is sufficient and much
// faster than the real-Mongo pattern used in `followSuggestion.test.ts`.
//
// The kill-switch scenario (`FOLLOW_SUGGESTION_ENABLED=false`) lives in a SEPARATE file
// (`user.controller.followSuggestion.enabled-false.test.ts`) because `FOLLOW_SUGGESTION_CONFIG`
// parses `process.env` once at import time and freezes — same constraint documented in
// `post.controller.dispatch.enabled-false.test.ts`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { getUserToFollows } from "./user.controller.ts";
import Follow from "../models/follow.model.ts";
import FollowSuggestion from "../models/followSuggestion.model.ts";
import User from "../models/user.model.ts";

const USER_A = "652f1b2c3d4e5f6071829301";
const USER_B = "652f1b2c3d4e5f6071829302"; // already followed by A
const USER_C = "652f1b2c3d4e5f6071829303"; // not followed by A

const buildRes = () =>
  ({
    status(code: number) {
      this._status = code;
      return this;
    },
    json(body: any) {
      this._body = body;
      return this;
    },
  }) as any;

const stubUserFindOneForRequester = (catesCare: any[] = []) => {
  const original = (User as any).findOne;
  (User as any).findOne = async () => ({ catesCare });
  return () => {
    (User as any).findOne = original;
  };
};

const stubFollowFindDistinct = (followeeIds: string[]) => {
  const original = (Follow as any).find;
  (Follow as any).find = () => ({
    distinct: async () => followeeIds,
  });
  return () => {
    (Follow as any).find = original;
  };
};

const stubUserFindHydrate = (docsById: Record<string, any>) => {
  const original = (User as any).find;
  (User as any).find = (filter: any) => ({
    lean: async () => {
      const ids: string[] = filter._id.$in.map((id: any) => String(id));
      return ids.map((id) => docsById[id]).filter(Boolean);
    },
  });
  return () => {
    (User as any).find = original;
  };
};

/* ------------------------------- Test 1: exclude-followed (FR-3) ------------------------------- */

test("Task 011, FR-3 scenario: cache-hit — candidate đã follow (B) bị loại, chỉ còn C", async () => {
  const restoreUserFindOne = stubUserFindOneForRequester();
  const restoreFollowFind = stubFollowFindDistinct([USER_B]);
  const restoreUserFind = stubUserFindHydrate({
    [USER_C]: { _id: USER_C, username: "c", avatar: "a", name: "C", bio: "", status: 1 },
  });

  const originalFollowSuggestionFindOne = (FollowSuggestion as any).findOne;
  (FollowSuggestion as any).findOne = () => ({
    lean: async () => ({
      candidates: [
        { userId: USER_B, score: 10, mutualFriendCount: 1, categoryOverlapCount: 0 },
        { userId: USER_C, score: 5, mutualFriendCount: 0, categoryOverlapCount: 1 },
      ],
    }),
  });

  const res = buildRes();
  try {
    await getUserToFollows(
      { query: { userId: USER_A, page: "1", limit: "20" } } as any,
      res,
    );
    assert.equal(res._status, 200);
    const ids = res._body.metadata.map((u: any) => String(u._id));
    assert.deepEqual(ids, [USER_C], "chỉ C (chưa follow) được trả về, B (đã follow) bị loại");
  } finally {
    (FollowSuggestion as any).findOne = originalFollowSuggestionFindOne;
    restoreUserFindOne();
    restoreFollowFind();
    restoreUserFind();
  }
});

/* --------------------------- Test 2: fallback-on-empty cache (FR-4) ----------------------------- */

test("Task 011, FR-4 scenario: FollowSuggestion không có candidate -> dùng fallback aggregation, không rỗng", async () => {
  const restoreUserFindOne = stubUserFindOneForRequester();
  const restoreFollowFind = stubFollowFindDistinct([]);

  const originalFollowSuggestionFindOne = (FollowSuggestion as any).findOne;
  (FollowSuggestion as any).findOne = () => ({
    lean: async () => ({ candidates: [] }),
  });

  const fallbackDocs = [{ _id: USER_C, username: "c" }];
  const originalAggregate = (User as any).aggregate;
  let aggregateCalled = false;
  (User as any).aggregate = async () => {
    aggregateCalled = true;
    return fallbackDocs;
  };

  const res = buildRes();
  try {
    await getUserToFollows(
      { query: { userId: USER_A, page: "1", limit: "20" } } as any,
      res,
    );
    assert.equal(res._status, 200);
    assert.equal(aggregateCalled, true, "fallback aggregation phải được gọi khi cache rỗng");
    assert.deepEqual(res._body.metadata, fallbackDocs);
    assert.ok(res._body.metadata.length > 0, "response fallback không được rỗng");
  } finally {
    (FollowSuggestion as any).findOne = originalFollowSuggestionFindOne;
    (User as any).aggregate = originalAggregate;
    restoreUserFindOne();
    restoreFollowFind();
  }
});

/* ------------------ Test 3: fallback-on-error (plan-review FAIL-2, part 2) ----------------------- */

test("Task 011, FR-4 scenario (FAIL-2): FollowSuggestion.findOne throw -> vẫn 200 với dữ liệu fallback, không phải 500", async () => {
  const restoreUserFindOne = stubUserFindOneForRequester();
  const restoreFollowFind = stubFollowFindDistinct([]);

  const originalFollowSuggestionFindOne = (FollowSuggestion as any).findOne;
  (FollowSuggestion as any).findOne = () => ({
    lean: async () => {
      throw new Error("simulated Mongo connection error");
    },
  });

  const fallbackDocs = [{ _id: USER_C, username: "c" }];
  const originalAggregate = (User as any).aggregate;
  let aggregateCalled = false;
  (User as any).aggregate = async () => {
    aggregateCalled = true;
    return fallbackDocs;
  };

  const res = buildRes();
  try {
    await getUserToFollows(
      { query: { userId: USER_A, page: "1", limit: "20" } } as any,
      res,
    );
    assert.equal(res._status, 200, "lỗi đọc cache KHÔNG được làm request thất bại (không phải 500)");
    assert.equal(aggregateCalled, true, "fallback aggregation phải được gọi khi đọc cache lỗi");
    assert.deepEqual(res._body.metadata, fallbackDocs);
  } finally {
    (FollowSuggestion as any).findOne = originalFollowSuggestionFindOne;
    (User as any).aggregate = originalAggregate;
    restoreUserFindOne();
    restoreFollowFind();
  }
});
