// Hai tầng trong file này:
//   1. Tầng THUẦN (task 010, dưới đây): discoveryBatchSize / planDiscovery / accountDiscovery —
//      không I/O, không import Post hay kiểu id Mongo nào. Được npm test phủ kín trực tiếp (không
//      cần Mongo).
//   2. Tầng I/O (task 011/T3, thêm SAU task này): `getDiscoveryCandidates` — sẽ thêm bên dưới,
//      có thể throw theo AD-4. KHÔNG được thêm ở đây.
//
// W-1: `planDiscovery` KHÔNG tự đọc cấu hình toàn cục (`discoveryEnabled`/`discoveryMaxSkip`) —
// chúng đến qua tham số `enabled`/`maxSkip`. Lý do: cấu hình đó parse lúc import (ESM cache theo
// process), nên test case `discoveryRatio = 0 -> n = 0` không thể cache-bust được nếu hàm tự đọc.
// Caller (index.ts, task 012) đọc cấu hình và truyền vào tham số.
import { FEED_CONFIG } from "./config.ts";

// Hàm DUY NHẤT trong file đọc FEED_CONFIG (`candidatePool`/`discoveryRatio`) — gọi ở caller (012),
// không gọi bên trong planDiscovery. Default: ceil(300 * 0.15) = 45.
export const discoveryBatchSize = (): number =>
  Math.ceil(FEED_CONFIG.candidatePool * FEED_CONFIG.discoveryRatio);

export type DiscoveryPlan = {
  mode: "off" | "blend" | "extend";
  offset: number;
  n: number;
};

// Không có tham số `rankedSize` — nó chỉ tồn tại SAU hydrate (đã phát query), dùng nó làm ngưỡng
// chọn chế độ sẽ tự sinh ra hai query mỗi request (vi phạm NFR-1). Chữ ký dưới đây khoá điều đó lại.
export const planDiscovery = ({
  enabled,
  source,
  basePoolSize,
  skip,
  limit,
  batch,
  maxSkip,
}: {
  enabled: boolean;
  source: string;
  basePoolSize: number;
  skip: number;
  limit: number;
  batch: number;
  maxSkip: number;
}): DiscoveryPlan => {
  // effectivePoolSize là biến DUY NHẤT dùng cho CẢ ngưỡng chọn chế độ LẪN phép trừ cursor —
  // đây là thứ làm ranh giới blend->extend liền mạch (trang cuối vùng blend phục vụ tới hạng
  // effectivePoolSize, trang đầu vùng extend bắt đầu ngay tại `batch`). KHÔNG thay bằng
  // `basePoolSize` trần trụi — sẽ đẩy viewer ít follow (US-1, basePoolSize nhỏ) sai sang nhánh
  // extend dù pool blend đã đủ chỗ (xem Key risk #1 trong task file).
  const effectivePoolSize = basePoolSize + batch;

  if (!enabled) return { mode: "off", offset: 0, n: 0 };

  // Nhánh "extend" PHẢI được xét TRƯỚC khi loại "mongo-fallback" (W-2/plan-review). Lý do PRD loại
  // fallback khỏi blend ("đã là query Mongo toàn bộ, thêm discovery trùng mục đích") chỉ đúng cho
  // blend — pool fallback vẫn bị chặn ở candidatePool, nên trang sâu vẫn cần discovery để lấp chỗ.
  // Đảo thứ tự thì viewer mongo-fallback (persona PRIMARY P1) không bao giờ được extend, và
  // slice() trên pool đã cạn sẽ trả [] vĩnh viễn ở trang sâu — đúng triệu chứng PRD tuyên bố đã xoá.
  if (skip + limit > effectivePoolSize) {
    return {
      mode: "extend",
      // max(0, ...): R-6 — làm bước nhảy offset nhỏ hơn limit đúng MỘT lần ở chỗ chuyển chế độ,
      // gây lặp tối đa (limit - 1) bài. Đây là ĐÚNG đặc tả, không phải bug — không được "sửa" bằng
      // cách nhớ offset đã phục vụ (đó là state, cấm theo C-4).
      offset: Math.min(batch + Math.max(0, skip - effectivePoolSize), maxSkip),
      n: limit,
    };
  }

  if (source === "mongo-fallback") return { mode: "off", offset: 0, n: 0 };

  return { mode: "blend", offset: 0, n: batch };
};

// CRIT-1: `page` (từ index.ts, `.map(({_id}) => _id)` trên document `.lean()`) là mảng id kiểu
// document Mongo — object có `.toString()`, KHÔNG phải string nguyên thuỷ — còn `discoveryIds` là
// string[]. `Set<string>.has(...)` dùng SameValueZero (so identity) nên LUÔN false một cách im
// lặng nếu không chuẩn hoá kiểu — đây là lỗi đã xảy ra trong chính bản kế hoạch đầu của epic này
// (xem TR-5). String() ở CẢ HAI phía để vá triệt để, bất kể phía nào tới dưới dạng gì.
export const accountDiscovery = (
  page: unknown[],
  discoveryIds: string[]
): { shown: number; bestRank: number | null; avgRank: number | null } => {
  const discoverySet = new Set(discoveryIds.map(String));
  const ranks: number[] = [];
  page.forEach((id, i) => {
    if (discoverySet.has(String(id))) ranks.push(i + 1); // rank 1-based
  });
  const shown = ranks.length;
  return {
    shown,
    // null khi shown === 0 — không phải 0 (không phân biệt được với rank hợp lệ) và không phải
    // NaN (Math.min() không đối số trả Infinity, reduce trên mảng rỗng không có base hợp lệ).
    bestRank: shown > 0 ? Math.min(...ranks) : null,
    avgRank: shown > 0 ? ranks.reduce((a, b) => a + b, 0) / shown : null,
  };
};
