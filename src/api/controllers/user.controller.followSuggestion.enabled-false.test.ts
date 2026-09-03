process.env.FOLLOW_SUGGESTION_ENABLED = "false";

import assert from "node:assert/strict";
import { test } from "node:test";

const USER_A = "652f1b2c3d4e5f6071829301";
const USER_B = "652f1b2c3d4e5f6071829302";

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

test("AD-6 kill-switch: FOLLOW_SUGGESTION_ENABLED=false -> luôn dùng fallback, bỏ qua cache dù cache có dữ liệu hợp lệ", async () => {
  const { getUserToFollows } = await import("./user.controller.ts");
  const { FOLLOW_SUGGESTION_CONFIG } = await import(
    "../services/followSuggestion/config.ts"
  );
  const { default: User } = await import("../models/user.model.ts");
  const { default: Follow } = await import("../models/follow.model.ts");
  const { default: FollowSuggestion } = await import(
    "../models/followSuggestion.model.ts"
  );

  assert.equal(FOLLOW_SUGGESTION_CONFIG.enabled, false, "env override phải có hiệu lực");

  const originalUserFindOne = (User as any).findOne;
  (User as any).findOne = async () => ({ catesCare: [] });

  const originalFollowFind = (Follow as any).find;
  (Follow as any).find = () => ({ distinct: async () => [] });

  let cacheReadCalls = 0;
  const originalFollowSuggestionFindOne = (FollowSuggestion as any).findOne;
  (FollowSuggestion as any).findOne = () => {
    cacheReadCalls++;
    return {
      lean: async () => ({
        candidates: [{ userId: USER_B, score: 999, mutualFriendCount: 5, categoryOverlapCount: 5 }],
      }),
    };
  };

  const fallbackDocs = [{ _id: "652f1b2c3d4e5f6071829303", username: "fallback-user" }];
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
    assert.equal(cacheReadCalls, 0, "kill-switch bật -> FollowSuggestion.findOne KHÔNG được gọi");
    assert.equal(aggregateCalled, true, "fallback aggregation phải được dùng dù cache có dữ liệu tốt");
    assert.equal(res._status, 200);
    assert.deepEqual(res._body.metadata, fallbackDocs);
  } finally {
    (User as any).findOne = originalUserFindOne;
    (Follow as any).find = originalFollowFind;
    (FollowSuggestion as any).findOne = originalFollowSuggestionFindOne;
    (User as any).aggregate = originalAggregate;
  }
});
