import PostConstants from "../../../Breads-Shared/Constants/PostConstants.js";
import { getRedisInstance } from "../../../dbs/redis.ts";
import { ObjectId } from "../../../utils/index.js";
import Follow from "../../models/follow.model.js";
import Post from "../../models/post.model.js";
import User from "../../models/user.model.js";
import { buildVisibilityQuery, getCandidatesFromMongo } from "../post.js";
import { FEED_CONFIG } from "./config.ts";
import { accountDiscovery, discoveryBatchSize, getDiscoveryCandidates, planDiscovery } from "./discovery.ts";
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
  viewerId = null,
  skip = 0,
  limit = 20,
}: {
  userId: any;
  /** Người ĐANG XEM (từ jwt). Mặc định `null` = ẩn danh -> chỉ thấy bài PUBLIC (fail-closed). */
  viewerId?: any;
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

    // FR-4/AD-2: dựng 1 lần, dùng lại cho cả 3 nguồn candidate. Điểm chặn BẮT BUỘC là bước
    // hydrate phía dưới — ZSET được ghi lúc fan-out nên không thể tin là còn đúng visibility
    // hiện tại của bài (tác giả đổi visibility sau khi đã fan-out).
    const visibilityQuery = await buildVisibilityQuery(viewerId);

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
          ...visibilityQuery,
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
          viewerId,
          limit: FEED_CONFIG.candidatePool,
        })
      ).map(String);
      source = "mongo-fallback";
    }
    // dedupe (R-7) — 022 thêm nguồn thứ hai, xử lý luôn trạng thái lai (tác giả vượt/tụt ngưỡng
    // celebrity nên post vừa nằm trong ZSET vừa bị pull lại). `Array.from` chứ không spread: repo
    // chưa set `target` trong tsconfig nên spread một Set là lỗi TS2802.
    poolIds = Array.from(new Set(poolIds));

    // FR-3: basePoolSize đo SAU dedupe, TRƯỚC hydrate. Đo trước dedupe làm effectivePoolSize lớn hơn
    // thực tế -> lệch ranh giới blend/extend VÀ sai phép trừ cursor FR-4, sai im lặng, chỉ lộ ở SC-4.
    const basePoolSize = poolIds.length;

    // W-1: batch/maxSkip tính ở CALLER rồi truyền vào — planDiscovery phải thuần để unit-test được
    // (FEED_CONFIG parse lúc import; xem AD-1/AD-5).
    const plan = planDiscovery({
      enabled: FEED_CONFIG.discoveryEnabled,
      source,
      basePoolSize,
      skip: skipNum,
      limit: limitNum,
      batch: discoveryBatchSize(),
      maxSkip: FEED_CONFIG.discoveryMaxSkip,
    });

    let discoveryIds: string[] = [];
    // GUARD BẮT BUỘC — KHÔNG được gỡ dù trông như tối ưu thừa (W-4/plan-review):
    // trong MongoDB `.limit(0)` nghĩa là KHÔNG GIỚI HẠN, không phải "không trả gì". Gỡ guard thì
    // FEED_DISCOVERY_RATIO=0 — đúng cấu hình user dùng để TẮT blend — sẽ phát một query sort TOÀN BỘ
    // collection không index, kích hoạt đúng R-1 (trần 32MB, throw) ở đúng lúc user tưởng đã tắt.
    if (plan.n > 0) {
      try {
        discoveryIds = await getDiscoveryCandidates({
          userId,
          poolIds,
          visibilityQuery,
          offset: plan.offset,
          n: plan.n,
        });
      } catch (err) {
        // NFR-3/AD-4: try/catch nằm ở CALL-SITE, không nằm trong getDiscoveryCandidates — nếu nằm
        // bên trong, stub-reject của SC-10 sẽ đi vòng qua chính lớp bảo vệ này. Feed cá nhân hoá
        // vẫn sống với discoveryIds = [].
        console.error("[feed] discovery failed:", err);
      }
    }
    // FR-3b blend-from-start: nối TRƯỚC hydrate — bài discovery đi chung MỘT query hydrate, tự có đủ
    // 4 field để rankCandidates chấm điểm, và tự có relevanceScore = 0 khi không khớp category
    // (Decision #8). Nối SAU hydrate = query thứ hai (vi phạm NFR-1) + finalScore NaN/0 im lặng.
    // rankCandidates / scoring.ts KHÔNG được sửa (C-2).
    if (plan.mode === "blend" && discoveryIds.length) {
      poolIds = poolIds.concat(discoveryIds);
    }
    // "extend" vẫn đi đường cũ (chưa nối) — thuộc 021/T6.

    const candidateMs = Date.now() - t0;

    let hydrateMs: number | null = null;
    let page: any[];

    if (plan.mode === "extend") {
      // AD-3: batch extend ĐÃ được Mongo sort theo engagementScore và ĐÃ nhúng visibilityQuery
      // (NFR-2 đòi "ít nhất một lần lọc"), nên bỏ qua HOÀN TOÀN hydrate + rankCandidates.
      // Hệ quả đo được: trang sâu tốn NET 0 query thêm so với baseline (mất hydrate, được discovery).
      // FR-4: THAY THẾ trang, KHÔNG nối vào phần ranked chưa phục vụ (cần state -> C-4 cấm) và
      // KHÔNG rank chung với pool cũ (bài mới sẽ chen vào giữa vị trí đã phục vụ ở trang trước).
      // R-6 (chấp nhận có ý thức): plan.offset = min(batch + max(0, skip - effectivePoolSize), maxSkip)
      // làm bước nhảy offset nhỏ hơn limit ĐÚNG MỘT LẦN ở chỗ chuyển chế độ -> lặp <= limit-1 bài (vd
      // 5 bài giữa skip=340 và skip=360), và sót <= limit-1 bài đã rank tại trang ranh giới. ĐÚNG ĐẶC
      // TẢ. KHÔNG được "sửa" bằng cách nhớ offset đã phục vụ — đó là state, C-4 cấm. Từ trang thứ hai
      // của vùng extend trở đi bước nhảy trở lại đúng limit (xem scenario skip=400 / 420 của FR-4).
      page = discoveryIds;
      // hydrateMs giữ null — W-6: 0 bị đọc nhầm thành "hydrate chạy và nhanh bất thường" khi xem log
      // 2 tuần sau; null nói đúng sự thật là bước đó không chạy. Đọc kèm discoveryMode.
    } else {
      // --- hydrate: MỘT query, projection đúng 4 field cần để chấm điểm ---
      const t1 = Date.now();
      const posts: any[] = await Post.find(
        { _id: { $in: poolIds.map((id) => ObjectId(id)) }, ...visibilityQuery },
        { _id: 1, engagementScore: 1, categories: 1, createdAt: 1 },
      ).lean();
      hydrateMs = Date.now() - t1;

      // --- chấm điểm toàn pool RỒI mới phân trang ---
      const nowMs = bucketedNow(Date.now(), FEED_CONFIG.scoreBucketSeconds);
      page = rankCandidates(posts, userCatesCare, nowMs)
        .slice(skipNum, skipNum + limitNum)
        .map(({ _id }) => _id);
    }

    // FR-5 + NTH-2 (AD-6). Gọi hàm THUẦN từ discovery.ts — KHÔNG dựng Set/duyệt page inline ở đây:
    // page là ObjectId[], discoveryIds là string[], Set<string>.has(objectId) LUÔN false một cách im
    // lặng (CRIT-1/TR-5). accountDiscovery chuẩn hoá String() ở cả hai phía.
    const { shown, bestRank, avgRank } = accountDiscovery(page, discoveryIds);

    // NTH-1: đường đọc có 2 lớp catch-all (getPostsIdByFilter, getPostDetail) nên bug thật và
    // "Redis down, đúng thiết kế" cho ra cùng một kết quả rỗng 200 OK. Dòng này phân biệt được.
    // poolSize giữ NGUYÊN nghĩa cũ (poolIds.length tại thời điểm log), tức ĐÃ CỘNG batch blend.
    // Quan hệ đúng: basePoolSize = poolSize - discoveryFetched ở blend; = poolSize ở extend/off.
    console.log("[feed]", {
      userId: String(userId),
      source,
      poolSize: poolIds.length,
      returned: page.length,
      candidateMs,
      hydrateMs,
      discoveryMode: plan.mode,
      discoveryFetched: discoveryIds.length,
      discoveryShown: shown,
      discoveryBestRank: bestRank, // NTH-2/AD-6 — null khi shown === 0, KHÔNG phải 0
      discoveryAvgRank: avgRank, // NTH-2/AD-6 — null khi shown === 0, KHÔNG phải NaN
    });
    return page;
  } catch (err) {
    console.error("[feed] ERROR", err); // KHÔNG throw — NFR-3
    return [];
  }
};
