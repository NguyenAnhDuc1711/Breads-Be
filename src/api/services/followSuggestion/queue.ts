// Task 010 (epic follow-suggestions) — BullMQ queue + worker cho suggestion precompute.
// Mirror `src/api/services/feed/queue.ts` 1:1 về hạ tầng (connection riêng, pattern
// registerXWorker/initXWorker/closeXQueue) — KHÔNG phát minh cách mới (010.md).
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import FollowSuggestion from "../../models/followSuggestion.model.ts";
import { computeSuggestionsForUser } from "../followSuggestion.ts";
import { FOLLOW_SUGGESTION_CONFIG } from "./config.ts";

/**
 * Connection BullMQ riêng, KHÔNG dùng chung `getRedisInstance()` (`src/dbs/redis.ts`) — cùng lý
 * do đã ghi ở `feed/queue.ts:6-11`: BullMQ bắt buộc `maxRetriesPerRequest: null`. Không export
 * instance này ra ngoài file (AD-2 epic.md) — task khác chỉ cần `followSuggestionQueue` /
 * `initFollowSuggestionWorker`.
 */
const connection = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null,
});

export const followSuggestionQueue = new Queue("follow-suggestion", { connection });

/** Worker đã đăng ký — chỉ để `closeFollowSuggestionQueue()` đóng được (lý do: `feed/queue.ts:21-24`). */
const workers: Worker[] = [];

export type FollowSuggestionJobData = { userIds: string[] };

export type ProcessBatchJobDeps = {
  /** Injectable cho test (mirror `processDispatchJob`'s `deps` ở `feed/fanout.ts`) — mặc định
   * dùng `computeSuggestionsForUser` thật. */
  compute?: (userId: string) => ReturnType<typeof computeSuggestionsForUser>;
};

/**
 * Xử lý 1 batch userId (~100-500, task 012 enqueue). Với MỖI userId: tính candidate rồi
 * **upsert** theo `{userId}` (KHÔNG `create`/insert) — bắt buộc để job an toàn re-run (FR-6).
 *
 * Xử lý TUẦN TỰ (không `Promise.all`) có chủ đích: nếu job bị kill/throw giữa batch (vd ở user
 * thứ 250/500), các user ĐÃ upsert xong trước đó giữ nguyên kết quả; BullMQ retry sẽ chạy lại
 * `processBatchJob` với CÙNG `job.data` từ đầu danh sách — mỗi user được upsert lại (ghi đè, không
 * insert thêm) nên kết quả cuối không trùng lặp (unique index `{userId:1}` trên
 * `followSuggestion.model.ts` là lớp bảo vệ thứ 2, nhưng upsert-theo-key mới là cơ chế chính đảm
 * bảo idempotency — unique index chỉ chặn `create`/insert trùng, không tự biến thao tác thành
 * upsert).
 *
 * `computedAt` được set TƯỜNG MINH trong `$set` (không dựa vào schema `default: Date.now`) vì
 * default đó chỉ áp dụng cho document tạo qua `new`, KHÔNG tự áp dụng cho `findOneAndUpdate`
 * upsert trừ khi truyền `setDefaultsOnInsert: true` (cảnh báo từ handoff task 001) — đằng nào
 * cũng cần giá trị `computedAt` cập nhật MỖI lần re-run (kể cả update, không chỉ insert), nên set
 * tường minh là đúng ngữ nghĩa hơn `setDefaultsOnInsert` (default chỉ set lúc insert).
 */
export const processBatchJob = async (
  data: FollowSuggestionJobData,
  deps: ProcessBatchJobDeps = {},
): Promise<void> => {
  const compute = deps.compute ?? computeSuggestionsForUser;
  for (const userId of data.userIds) {
    const candidates = await compute(userId);
    await FollowSuggestion.findOneAndUpdate(
      { userId },
      { $set: { candidates, computedAt: new Date() } },
      { upsert: true },
    );
  }
};

/**
 * Enqueue tính suggestion cho ĐÚNG 1 user, ngoài luồng sweep định kỳ của cron — dùng cho 2 trường
 * hợp: (1) user hoàn toàn chưa có `FollowSuggestion` doc lúc đọc (`getUserToFollows` cache-miss),
 * (2) ngay sau khi user đăng ký (`validateEmailByCode`). Không throw ra ngoài — caller gọi
 * fire-and-forget (không `await` kết quả job), lỗi enqueue chỉ nên log chứ không được ảnh hưởng
 * response đang trả cho request khác.
 *
 * `jobId` cố định theo `userId` để BullMQ tự dedup: nhiều request trùng thời điểm cho cùng 1 user
 * chỉ tạo ra ĐÚNG 1 job đang chờ, không xếp hàng lặp lại vô ích.
 *
 * `priority: 1` (khác mặc định — job cron sweep không set priority) để job on-demand được xử lý
 * TRƯỚC các job sweep hàng trăm-user đang xếp hàng, không bị chờ lâu phía sau hàng nghìn job cron.
 */
export const enqueueOnDemandSuggestion = async (userId: string): Promise<void> => {
  if (!FOLLOW_SUGGESTION_CONFIG.enabled) return;
  try {
    await followSuggestionQueue.add(
      "on-demand-user",
      { userIds: [userId] },
      {
        jobId: `on-demand:${userId}`,
        priority: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  } catch (err) {
    console.error("[follow-suggestion-queue] enqueueOnDemandSuggestion failed:", err);
  }
};

export const registerFollowSuggestionWorker = (conn: Redis): Worker => {
  const worker = new Worker(
    "follow-suggestion",
    async (job) => processBatchJob(job.data),
    { connection: conn, concurrency: FOLLOW_SUGGESTION_CONFIG.workerConcurrency },
  );
  workers.push(worker);
  return worker;
};

/**
 * Call site (`src/worker.ts`) BẮT BUỘC bọc try/catch RIÊNG (không dùng chung với
 * `initFanoutWorkers`) — một lỗi khởi tạo suggestion worker không được crash toàn bộ worker
 * process/feed-fanout worker (AD-2, task 010 AC "isolation").
 */
export const initFollowSuggestionWorker = (): void => {
  registerFollowSuggestionWorker(connection);
};

/**
 * Đóng `Queue` + toàn bộ `Worker` + connection nội bộ — dùng cho teardown test và graceful
 * shutdown (lý do i hệt `feed/queue.ts:closeFanoutQueues`).
 */
export const closeFollowSuggestionQueue = async (): Promise<void> => {
  await Promise.all(workers.splice(0).map((w) => w.close()));
  await followSuggestionQueue.close();
  await connection.quit();
};
