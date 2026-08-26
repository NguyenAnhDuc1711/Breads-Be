// Task 012 (epic follow-suggestions) — cron trigger định kỳ enqueue job refresh suggestion
// (NFR-2). Không có Worker mới ở đây — chỉ enqueue vào `followSuggestionQueue` (task 010).
//
// Lock overlap-guard (AD-7, epic.md — fix sau plan-review FAIL-1): BẮT BUỘC TTL-based qua Redis
// `SET <key> <value> NX EX <ttl>`, KHÔNG dùng SETNX/flag không hết hạn — nếu process giữ lock
// crash giữa chừng (không gọi release), lock phải tự hết hạn thay vì kẹt vĩnh viễn.
import cron from "node-cron";
import mongoose from "mongoose";
import { getRedisInstance } from "../../../dbs/redis.ts";
import User from "../../models/user.model.ts";
import { followSuggestionQueue, type FollowSuggestionJobData } from "./queue.ts";
import { FOLLOW_SUGGESTION_CONFIG } from "./config.ts";

/** Key lock dùng chung với backfill script (task 020) — cả 2 phải cùng key để ngăn overlap thật
 * sự (NFR-2). Export để test dọn dẹp giữa các case (`redis.del(LOCK_KEY)`). */
export const LOCK_KEY = "follow-suggestion:refresh-lock";

/** Batch user/job — trong khoảng 100-500 theo 012.md Description. Export để test tính trước số
 * job kỳ vọng từ tổng số user seed, không cần đoán số cứng. */
export const ENQUEUE_BATCH_SIZE = 300;

/**
 * Acquire lock TTL-based (AD-7). Trả `true` nếu acquire thành công (lock trước đó không tồn tại
 * hoặc đã hết hạn), `false` nếu lock đang bị process khác giữ (backfill task 020 hoặc 1 lần cron
 * trước chưa xong/chưa hết TTL).
 *
 * `lockValue` chỉ dùng để nhận diện ai đang giữ lock (debug/log) — KHÔNG dùng cho một release có
 * kiểm tra quyền sở hữu, vì hàm này cố ý không có release (xem `runFollowSuggestionRefresh`).
 */
export const acquireLock = async (
  lockValue: string,
  ttlSeconds: number,
): Promise<boolean> => {
  const redis = getRedisInstance();
  if (!redis) {
    console.warn(
      "[follow-suggestion-cron] Redis chưa init (getRedisInstance() = null) — coi như acquire " +
        "lock thất bại, bỏ qua lần chạy này (fail-safe: không enqueue khi không chắc chắn không " +
        "có process khác đang chạy).",
    );
    return false;
  }
  const result = await redis.set(LOCK_KEY, lockValue, "EX", ttlSeconds, "NX");
  return result === "OK";
};

export type RunFollowSuggestionRefreshDeps = {
  /** Injectable cho test (mirror `ProcessBatchJobDeps` ở `queue.ts`) — mặc định enqueue thật vào
   * `followSuggestionQueue`. */
  enqueue?: (data: FollowSuggestionJobData) => Promise<unknown>;
  /** Injectable cho test — cho phép seed ít user hơn 300 mà vẫn verify được logic chia nhiều
   * batch, không phải insert hàng trăm document giả chỉ để lấp đầy 1 batch. */
  batchSize?: number;
};

export type RunFollowSuggestionRefreshResult = {
  /** `false` nếu bỏ qua lần chạy này vì lock đang bị giữ (AC "ngăn overlap", NFR-2). */
  acquired: boolean;
  /** Số job đã enqueue (0 nếu không acquire được lock, hoặc không có user nào). */
  jobCount: number;
};

/**
 * 1 lần chạy refresh: acquire lock -> đọc user theo batch cursor `_id` (KHÔNG resume, cron chạy
 * lại toàn bộ mỗi lần theo đúng 012.md) -> enqueue mỗi batch thành 1 job vào `follow-suggestion`
 * queue (task 010).
 *
 * Lock CỐ Ý KHÔNG được release tường minh ở cuối hàm (AD-7 trade-off): release ngay sau khi
 * enqueue xong chỉ mới là enqueue xong — worker (task 010) vẫn còn đang xử lý các job đó, nên
 * release sớm ở đây vẫn cho backfill (task 020) chen vào giữa lúc suggestion thật sự chưa tính
 * xong. `lockTtlSeconds` (mặc định 1800s, `FOLLOW_SUGGESTION_CONFIG`) được chọn CHỦ ĐÍCH dài hơn
 * thời gian xử lý tối đa dự kiến của 1 lần refresh, nên để TTL tự hết hạn là cơ chế release DUY
 * NHẤT — vừa đơn giản (không cần theo dõi "queue đã rỗng chưa"), vừa tránh lớp bug kinh điển của
 * distributed lock: release không kiểm tra quyền sở hữu có thể xoá nhầm lock mà một process khác
 * đã acquire hợp lệ sau khi lock của mình đã tự hết hạn.
 */
export const runFollowSuggestionRefresh = async (
  deps: RunFollowSuggestionRefreshDeps = {},
): Promise<RunFollowSuggestionRefreshResult> => {
  const enqueue =
    deps.enqueue ??
    ((data: FollowSuggestionJobData) => followSuggestionQueue.add("refresh-batch", data));
  const batchSize = deps.batchSize ?? ENQUEUE_BATCH_SIZE;
  const lockValue = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

  const acquired = await acquireLock(lockValue, FOLLOW_SUGGESTION_CONFIG.lockTtlSeconds);
  if (!acquired) {
    console.warn(
      `[follow-suggestion-cron] lock "${LOCK_KEY}" đang bị giữ (backfill task 020 hoặc lần chạy ` +
        `trước chưa hết TTL) — bỏ qua lần chạy này, KHÔNG enqueue.`,
    );
    return { acquired: false, jobCount: 0 };
  }

  let jobCount = 0;
  let cursor: mongoose.Types.ObjectId | undefined;
  for (;;) {
    const users = await User.find(cursor ? { _id: { $gt: cursor } } : {})
      .sort({ _id: 1 })
      .limit(batchSize)
      .select("_id")
      .lean();
    if (users.length === 0) break;

    const userIds = users.map((u: any) => String(u._id));
    await enqueue({ userIds });
    jobCount += 1;
    cursor = users[users.length - 1]._id;

    if (users.length < batchSize) break;
  }

  console.log(
    `[follow-suggestion-cron] enqueued ${jobCount} batch job(s); lock "${LOCK_KEY}" sẽ tự hết ` +
      `hạn sau ${FOLLOW_SUGGESTION_CONFIG.lockTtlSeconds}s (không release tường minh, xem AD-7).`,
  );
  return { acquired: true, jobCount };
};

/**
 * Đăng ký cron theo `FOLLOW_SUGGESTION_CONFIG.refreshCronSchedule`. Lỗi trong 1 lần chạy chỉ log
 * (KHÔNG throw ra khỏi callback của `node-cron` — 1 lần chạy lỗi không được làm cron ngừng lịch
 * những lần sau). Trả về `ScheduledTask` (có `.stop()`) để caller/test tự dọn dẹp khi cần.
 */
export const initFollowSuggestionCron = () =>
  cron.schedule(FOLLOW_SUGGESTION_CONFIG.refreshCronSchedule, () => {
    runFollowSuggestionRefresh().catch((err) => {
      console.error("[follow-suggestion-cron] runFollowSuggestionRefresh failed:", err);
    });
  });
