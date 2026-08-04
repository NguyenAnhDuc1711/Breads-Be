import { ObjectId } from "../../../utils/index.js";
import Post from "../../models/post.model.js";
import User from "../../models/user.model.js";
import { getCandidatesFromMongo } from "../post.js";
import { FEED_CONFIG } from "./config.ts";
import { bucketedNow, rankCandidates } from "./scoring.ts";
import { zRevRangeTop } from "./zset.ts";

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
    let source = "mongo-fallback";
    let poolIds: string[] = [];
    if (FEED_CONFIG.fanoutEnabled) {
      // non-throwing: trả [] khi Redis null/lỗi/quá chậm.
      poolIds = await withTimeout(
        zRevRangeTop(String(userId), FEED_CONFIG.candidatePool),
        [],
      );
      if (poolIds.length) source = "zset";
      // [022/T7: zExists -> sentinel -> rebuildUserFeedZset -> đọc lại chèn vào đây]
    }
    // [022/T7: merge candidate celebrity vào `poolIds` ở đây -> source = "celebrity"]
    if (!poolIds.length) {
      poolIds = (
        await getCandidatesFromMongo({
          userId,
          limit: FEED_CONFIG.candidatePool,
        })
      ).map(String);
      source = "mongo-fallback";
    }
    // dedupe (R-7) — 022 thêm nguồn thứ hai. `Array.from` chứ không spread: repo chưa set
    // `target` trong tsconfig nên spread một Set là lỗi TS2802.
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
