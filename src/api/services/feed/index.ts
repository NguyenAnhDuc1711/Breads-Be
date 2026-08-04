import PostConstants from "../../../Breads-Shared/Constants/PostConstants.js";
import { getRedisInstance } from "../../../dbs/redis.ts";
import { ObjectId } from "../../../utils/index.js";
import Follow from "../../models/follow.model.js";
import Post from "../../models/post.model.js";
import User from "../../models/user.model.js";
import { getCandidatesFromMongo } from "../post.js";
import { FEED_CONFIG } from "./config.ts";
import { rebuildUserFeedZset, rebuiltSentinelKey } from "./fanout.ts";
import { bucketedNow, rankCandidates } from "./scoring.ts";
import { zExists, zRevRangeTop } from "./zset.ts";

/**
 * Ngân sách thời gian cho **một** lời gọi Redis trong đường đọc.
 *
 * Đo được: khi Redis không kết nối được (host/port sai, service chết) nhưng instance đã được tạo,
 * ioredis xếp lệnh vào offline queue thay vì fail ngay — `zRevRangeTop` treo ~19-29s rồi mới trả `[]`.
 * NFR-3 vẫn "không 5xx", nhưng feed 19s thì cũng như chết. Race với timeout để rơi xuống
 * mongo-fallback ngay. Nguồn gốc thật nằm ở `enableOfflineQueue` trong `src/dbs/redis.ts` — ngoài
 * phạm vi task này, đã ghi vào handoff cho 021/022.
 */
const REDIS_READ_TIMEOUT_MS = 200;

const withTimeout = <T>(p: Promise<T>, fallback: T): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((resolve) =>
      setTimeout(() => resolve(fallback), REDIS_READ_TIMEOUT_MS),
    ),
  ]);

/**
 * `EXISTS feed:rebuilt:{userId}` — non-throwing, cùng hợp đồng với `zset.ts` (AD-5).
 *
 * [022/T7 FAIL-2] Đọc sentinel do `rebuildUserFeedZset` (021) ghi khi rebuild ra 0 entry. Không dùng
 * `getCache` của `src/dbs/redis.ts`: hàm đó `throw` khi Redis chết. Đặt cục bộ ở đây thay vì `zset.ts`
 * vì file scope của task này chỉ là `feed/index.ts`.
 */
const sentinelExists = async (userId: string): Promise<boolean> => {
  const r = getRedisInstance();
  if (!r) return false;
  try {
    return (await r.exists(rebuiltSentinelKey(userId))) === 1;
  } catch (err) {
    console.error("[feed] sentinelExists failed:", err);
    return false;
  }
};

/**
 * Đường đọc hybrid cho feed "For You" (FR-7).
 *
 * Điểm mấu chốt: pool candidate có kích thước **cố định** (`FEED_CONFIG.candidatePool`),
 * không phụ thuộc `skip`/`limit`; toàn bộ pool được chấm điểm rồi mới `slice(skip, skip+limit)`
 * (AD-4). Pipeline cũ làm ngược lại — phân trang theo `createdAt` trước rồi mới chấm điểm 20 bài
 * đã chọn — nên xếp hạng gần như vô hiệu.
 *
 * Mọi lỗi đều bị nuốt và trả `[]` (NFR-3): Redis chết không được biến thành 5xx.
 */
export const getForYouFeed = async ({
  userId,
  skip = 0,
  limit = 20,
}: {
  userId: any;
  skip?: number | string;
  limit?: number | string;
}): Promise<any[]> => {
  // `skip`/`limit` đến từ query string nên có thể là chuỗi: `0 + "20"` = `"020"`.
  const skipNum = Number(skip) || 0;
  const limitNum = Number(limit) || 20;
  const t0 = Date.now();
  try {
    const user: any = await User.findOne(
      { _id: ObjectId(userId) },
      { catesCare: 1 },
    ).lean();
    const userCatesCare = user?.catesCare ?? [];

    // --- candidate generation ---
    let source = "";
    let poolIds: string[] = [];
    if (FEED_CONFIG.fanoutEnabled) {
      // non-throwing: trả [] khi Redis null/lỗi/quá chậm.
      poolIds = await withTimeout(
        zRevRangeTop(String(userId), FEED_CONFIG.candidatePool),
        [],
      );
      if (!poolIds.length) {
        const exists = await withTimeout(zExists(String(userId)), false);
        if (!exists) {
          // [022/T7 FAIL-2] sentinel chặn rebuild lặp lại khi lần rebuild trước ra 0 entry
          // (user mới / chỉ follow celebrity) — tránh stampede tự gây ra ở mỗi request tiếp theo.
          const recentlyRebuilt = await withTimeout(
            sentinelExists(String(userId)),
            false,
          );
          if (!recentlyRebuilt) {
            const n = await rebuildUserFeedZset(userId);
            if (n > 0) {
              poolIds = await withTimeout(
                zRevRangeTop(String(userId), FEED_CONFIG.candidatePool),
                [],
              );
            }
          }
        }
      }
      if (poolIds.length) source = "zset";
    }

    // [022/T7 FR-6] Merge candidate celebrity: celebrity không bao giờ có ZADD (fan-out write bỏ
    // qua họ, 021), nên follower của họ chỉ thấy bài nếu ta pull-on-read ở đây. Chạy ĐỘC LẬP với
    // kết quả ZSET phía trên (kể cả khi source đã là "zset") — dedupe theo postId ở cuối xử lý
    // trạng thái lai (R-7) khi tác giả vượt/tụt ngưỡng celebrity.
    const celebRows: { followeeId: any }[] = await Follow.aggregate([
      { $match: { followerId: ObjectId(userId) } },
      {
        $lookup: {
          from: "users",
          localField: "followeeId",
          foreignField: "_id",
          as: "u",
          pipeline: [
            { $match: { followersCount: { $gt: FEED_CONFIG.celebrityThreshold } } },
            { $project: { _id: 1 } },
          ],
        },
      },
      { $match: { "u.0": { $exists: true } } },
      { $project: { _id: 0, followeeId: 1 } },
    ]);
    const celebrityIds = celebRows.map((r) => r.followeeId);
    // 0 query phụ khi viewer không follow celebrity nào (đa số) — guard bắt buộc, không phải
    // "một query trả 0 dòng".
    if (celebrityIds.length) {
      const { CREATE, EDIT, REPOST } = PostConstants.ACTIONS;
      const celebPosts: { _id: unknown }[] = await Post.find(
        {
          authorId: { $in: celebrityIds },
          type: { $in: [CREATE, EDIT, REPOST] },
          createdAt: {
            $gte: new Date(Date.now() - FEED_CONFIG.activeWindowDays * 86400_000),
          },
        },
        { _id: 1 },
      )
        .sort({ createdAt: -1 })
        .limit(FEED_CONFIG.candidatePool)
        .lean();
      if (celebPosts.length) {
        poolIds = poolIds.concat(celebPosts.map((p) => String(p._id)));
        source = source === "zset" ? "zset+celebrity" : "celebrity";
      }
    }

    // [022/T7 NFR-3/SC-14] Fallback ĐÚNG NHÁNH: chỉ khi cả ZSET (kể cả sau lazy rebuild) VÀ
    // celebrity merge đều không cho ra gì thì mới rơi về Mongo đầy đủ — KHÔNG dùng nhánh celebrity
    // làm fallback (viewer không follow celebrity nào sẽ nhận feed rỗng nếu nhầm chỗ này).
    if (!poolIds.length) {
      poolIds = (
        await getCandidatesFromMongo({
          userId,
          limit: FEED_CONFIG.candidatePool,
        })
      ).map(String);
      source = "mongo-fallback";
    }
    // dedupe (R-7) — 022 thêm nguồn thứ hai, xử lý luôn trạng thái lai (tác giả vượt/tụt ngưỡng
    // celebrity nên post vừa nằm trong ZSET vừa bị pull lại). `Array.from` chứ không spread: repo
    // chưa set `target` trong tsconfig nên spread một Set là lỗi TS2802.
    poolIds = Array.from(new Set(poolIds));
    const candidateMs = Date.now() - t0;

    // --- hydrate: MỘT query, projection đúng 4 field cần để chấm điểm ---
    const t1 = Date.now();
    const posts: any[] = await Post.find(
      { _id: { $in: poolIds.map((id) => ObjectId(id)) } },
      { _id: 1, engagementScore: 1, categories: 1, createdAt: 1 },
    ).lean();
    const hydrateMs = Date.now() - t1;

    // --- chấm điểm toàn pool RỒI mới phân trang ---
    const nowMs = bucketedNow(Date.now(), FEED_CONFIG.scoreBucketSeconds);
    const page = rankCandidates(posts, userCatesCare, nowMs)
      .slice(skipNum, skipNum + limitNum)
      .map(({ _id }) => _id);

    // NTH-1: đường đọc có 2 lớp catch-all (getPostsIdByFilter, getPostDetail) nên bug thật và
    // "Redis down, đúng thiết kế" cho ra cùng một kết quả rỗng 200 OK. Dòng này phân biệt được.
    console.log("[feed]", {
      userId: String(userId),
      source,
      poolSize: poolIds.length,
      returned: page.length,
      candidateMs,
      hydrateMs,
    });
    return page;
  } catch (err) {
    console.error("[feed] ERROR", err); // KHÔNG throw — NFR-3
    return [];
  }
};
