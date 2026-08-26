// Task 020 (epic follow-suggestions) — CLI backfill resumable: nạp `FollowSuggestion` cho toàn bộ
// user hiện có (~6M, mocked). Cron (task 012, `followSuggestion/cron.ts`) chỉ refresh định kỳ theo
// lịch — không phù hợp cho lần nạp đầu, vì chạy hết 6M user cùng lúc qua cron sẽ gây quá tải
// Mongo/Redis không kiểm soát được thời điểm (R-2, epic.md). Script này cho phép giới hạn
// concurrency tường minh (`--concurrency`) và BẮT BUỘC resumable (AD-8, plan-review FAIL-3): một
// lần crash giữa chừng trên tập dữ liệu lớn không được buộc chạy lại từ đầu — làm vậy sẽ lặp lại
// đúng rủi ro quá tải mà giới hạn concurrency đang cố tránh.
//
// Convention CLI tham chiếu: `migrateFollowLike.ts` / `backfillLikeFollowCounts.ts` (dotenv +
// `mongoose.connect`, log console, `isMainModule` guard để export hàm core dùng lại được từ nơi
// khác — pattern `verifyEngagementScoreBackfillProd.ts`).
//
// Resume-state: 1 collection Mongo nhỏ `backfillProgress` (KHÔNG dùng file JSON local) — script
// này chạy trên môi trường có thể là container/ephemeral filesystem (staging/prod), 1 doc Mongo
// bền qua các lần chạy trên các host/container khác nhau và không cần lo đường dẫn/quyền ghi file
// cục bộ; chi phí thêm 1 collection nhỏ (1 doc duy nhất, keyed theo `scriptName`) là chấp nhận
// được so với lợi ích đó.
import dotenv from "dotenv";
import mongoose, { type Types } from "mongoose";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import User from "../models/user.model.ts";
import {
  processBatchJob,
  type ProcessBatchJobDeps,
} from "../services/followSuggestion/queue.ts";
import { FOLLOW_SUGGESTION_CONFIG } from "../services/followSuggestion/config.ts";
import { LOCK_KEY } from "../services/followSuggestion/cron.ts";
import initRedis, { getRedisInstance } from "../../dbs/redis.ts";

dotenv.config();

const PROGRESS_COLLECTION = "backfillProgress";
const SCRIPT_NAME = "follow-suggestions";
const DEFAULT_CONCURRENCY = 5;

// ---- Progress (checkpoint) persistence -----------------------------------------------------
// Doc duy nhất keyed theo `scriptName` — đọc lại `lastProcessedId` khi `--resume`, ghi đè sau mỗi
// trang xử lý xong (điểm 3/4, 020.md).

const readLastProcessedId = async (): Promise<Types.ObjectId | null> => {
  const doc = await mongoose.connection.db
    .collection(PROGRESS_COLLECTION)
    .findOne({ scriptName: SCRIPT_NAME });
  return (doc?.lastProcessedId as Types.ObjectId | undefined) ?? null;
};

const saveLastProcessedId = async (lastProcessedId: Types.ObjectId): Promise<void> => {
  await mongoose.connection.db.collection(PROGRESS_COLLECTION).updateOne(
    { scriptName: SCRIPT_NAME },
    { $set: { lastProcessedId, updatedAt: new Date() } },
    { upsert: true },
  );
};

// ---- Core backfill loop (đơn vị test — không đụng Redis/lock, xem `main()` bên dưới) -------

export type BackfillOptions = {
  concurrency: number;
  resume: boolean;
  /** CLI dùng để dừng có kiểm soát khi SIGINT/SIGTERM — kiểm tra ở ĐẦU mỗi vòng lặp, trước khi
   * fetch trang kế tiếp, nên tiến độ của trang vừa xong luôn đã được lưu trước khi dừng. */
  shouldStop?: () => boolean;
};

export type BackfillDeps = Pick<ProcessBatchJobDeps, "compute">;

export type BackfillResult = { processedCount: number };

/**
 * Xử lý user theo thứ tự `_id` tăng dần, cursor-based (`_id > lastProcessedId`, KHÔNG `.skip()` —
 * chậm ở quy mô 6M vì Mongo vẫn phải duyệt qua N doc bị skip mỗi lần, trong khi range query trên
 * `_id` tận dụng index sẵn có — điểm 2, 020.md).
 *
 * Mỗi "trang" đúng bằng `concurrency` user một, xử lý ĐỒNG THỜI qua `Promise.all` rồi mới lưu
 * checkpoint: vì cỡ trang == concurrency, số lời gọi `computeSuggestionsForUser` in-flight tại MỌI
 * thời điểm trong suốt quá trình chạy không bao giờ vượt `concurrency` (điểm 5 + AC "concurrency
 * limit"), và checkpoint chỉ nhích lên sau khi CẢ trang xong nên 1 lỗi/crash giữa trang không làm
 * mất tiến độ của các trang trước đó (AD-8) — trang bị lỗi được xử lý lại toàn bộ khi `--resume`,
 * an toàn nhờ `processBatchJob` upsert theo `userId` (idempotent, task 010).
 * Trade-off: 1 trang phải chờ user chậm nhất trong trang mới sang trang kế tiếp (không phải 1 pool
 * liên tục giữ đủ N tác vụ bận) — chấp nhận được vì ưu tiên đơn giản + đúng ngữ nghĩa checkpoint
 * hơn tối đa hoá throughput (default `--concurrency` vốn đã thấp, 5).
 */
export const runBackfill = async (
  options: BackfillOptions,
  deps: BackfillDeps = {},
): Promise<BackfillResult> => {
  const { concurrency, resume, shouldStop } = options;
  let cursor = resume ? await readLastProcessedId() : null;
  let processedCount = 0;

  while (!(shouldStop?.() ?? false)) {
    const filter = cursor ? { _id: { $gt: cursor } } : {};
    const page: { _id: Types.ObjectId }[] = await User.find(filter, { _id: 1 })
      .sort({ _id: 1 })
      .limit(concurrency)
      .lean();
    if (page.length === 0) break;

    await Promise.all(page.map((u) => processBatchJob({ userIds: [String(u._id)] }, deps)));

    cursor = page[page.length - 1]._id;
    processedCount += page.length;
    await saveLastProcessedId(cursor);
    console.log(
      `[backfill-follow-suggestions] processed ${processedCount} users so far (cursor=${cursor})`,
    );
  }

  return { processedCount };
};

// ---- Lock (đồng bộ với task 012 cron, AD-7/NFR-2) -------------------------------------------
// `LOCK_KEY` import từ `cron.ts` (task 012) — sửa sau verify Phase A gap G-2: 2 script từng tự
// khai báo cùng 1 string literal độc lập (đã verify khớp nhau lúc đó, nhưng dễ vỡ nếu sau này
// sửa 1 bên mà quên bên kia). Cùng nguồn TTL (`FOLLOW_SUGGESTION_CONFIG.lockTtlSeconds`) để 2
// script loại lẫn nhau thật sự.

type LockHandle = { extend: () => Promise<void>; release: () => Promise<void> };

const acquireLock = async (): Promise<LockHandle | null> => {
  const redis = getRedisInstance();
  if (!redis) throw new Error("Redis instance not found");
  const token = randomUUID();
  const ok = await redis.set(LOCK_KEY, token, "EX", FOLLOW_SUGGESTION_CONFIG.lockTtlSeconds, "NX");
  if (ok !== "OK") return null;
  return {
    // Backfill 6M user có thể chạy lâu hơn `lockTtlSeconds` (mặc định 1800s) — không refresh sẽ
    // khiến lock tự hết hạn giữa chừng và cron (task 012) có thể chen vào, đúng race NFR-2 muốn
    // ngăn. Refresh mỗi nửa TTL (`main()`), chỉ khi vẫn còn giữ ĐÚNG token của mình (so sánh trước
    // khi EXPIRE — tránh gia hạn/xoá nhầm lock của người khác nếu TTL đã hết và ai đó khác vừa
    // acquire được đúng lúc đó).
    extend: async () => {
      const current = await redis.get(LOCK_KEY);
      if (current === token) await redis.expire(LOCK_KEY, FOLLOW_SUGGESTION_CONFIG.lockTtlSeconds);
    },
    release: async () => {
      const current = await redis.get(LOCK_KEY);
      if (current === token) await redis.del(LOCK_KEY);
    },
  };
};

// ---- CLI entry --------------------------------------------------------------------------------

const parseArgs = (argv: string[]): { concurrency: number; resume: boolean } => {
  let concurrency = DEFAULT_CONCURRENCY;
  let resume = false;
  for (const arg of argv) {
    if (arg === "--resume") {
      resume = true;
    } else if (arg.startsWith("--concurrency=")) {
      const value = Number(arg.slice("--concurrency=".length));
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`--concurrency phải là số nguyên >= 1, nhận: "${arg}"`);
      }
      concurrency = value;
    }
  }
  return { concurrency, resume };
};

const main = async () => {
  const { concurrency, resume } = parseArgs(process.argv.slice(2));
  console.log(
    `[backfill-follow-suggestions] start (concurrency=${concurrency}, resume=${resume})`,
  );

  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017");
  initRedis();
  await new Promise<void>((resolve, reject) => {
    const r = getRedisInstance()!;
    if (r.status === "ready") return resolve();
    r.once("ready", () => resolve());
    r.once("error", reject);
  });

  const lock = await acquireLock();
  if (!lock) {
    console.error(
      `[backfill-follow-suggestions] không lấy được lock "${LOCK_KEY}" (cron task 012 hoặc 1 lần ` +
        "chạy backfill khác đang giữ) — bỏ qua lần chạy này, thử lại sau.",
    );
    await mongoose.disconnect();
    await getRedisInstance()?.quit();
    process.exit(1);
  }

  const heartbeat = setInterval(
    () => void lock.extend(),
    Math.floor((FOLLOW_SUGGESTION_CONFIG.lockTtlSeconds * 1000) / 2),
  );
  heartbeat.unref();

  let stopRequested = false;
  const requestStop = (signal: string) => {
    console.log(
      `[backfill-follow-suggestions] nhận ${signal} — dừng sau khi trang hiện tại xong (tiến độ ` +
        "đã lưu, chạy lại với --resume để tiếp tục).",
    );
    stopRequested = true;
  };
  process.on("SIGINT", () => requestStop("SIGINT"));
  process.on("SIGTERM", () => requestStop("SIGTERM"));

  try {
    const { processedCount } = await runBackfill({
      concurrency,
      resume,
      shouldStop: () => stopRequested,
    });
    console.log(
      `[backfill-follow-suggestions] hoàn tất: ${processedCount} user đã xử lý trong lần chạy này.`,
    );
  } finally {
    clearInterval(heartbeat);
    await lock.release();
    await mongoose.disconnect();
    await getRedisInstance()?.quit();
  }
  process.exit(stopRequested ? 130 : 0);
};

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((err) => {
    console.error("[backfill-follow-suggestions] failed:", err);
    process.exit(1);
  });
}
