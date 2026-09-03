import {
  destructObjectId,
  formatDate,
  getCollection,
  getCountKeyAnalyticValue,
  getDatesInRange,
  getOSFromUserAgent,
} from "../../utils/index.js";
import logger from "../../core/logger.js";

const getUserActiveData = (datesData, dateRange) => {
  const result = dateRange.map((date) => {
    // Get all user IDs for the date
    const userIds = datesData
      .filter((event) => formatDate(event.createdAt) == date)
      .map((event) => destructObjectId(event.userId));

    const uniqueUserIds = new Set(userIds);

    return {
      date: date,
      data: uniqueUserIds.size,
    };
  });
  return result;
};

const getUserDeviceData = (datesData) => {
  const result = getCountKeyAnalyticValue({
    data: datesData,
    keyLayer1: "deviceInfo",
    keyLayer2: "category",
  });
  return result;
};

const getUserLocaleData = (datesData) => {
  const result = getCountKeyAnalyticValue({
    data: datesData,
    keyLayer1: "localeInfo",
    keyLayer2: "locale",
  });
  return result;
};

const getUserOS = (datesData) => {
  const result = getCountKeyAnalyticValue({
    data: datesData,
    keyLayer1: "browserInfo",
    keyLayer2: "userAgent",
  });
  const userAgentKeys: string[] = [];
  Object.keys(result).forEach((key) => {
    const OSName = getOSFromUserAgent(key);
    result[OSName] = result[key];
    userAgentKeys.push(key);
  });
  userAgentKeys.forEach((key) => {
    delete result[key];
  });

  return result;
};

const getEventsData = (datesData) => {
  const result = getCountKeyAnalyticValue({
    data: datesData,
    keyLayer1: "event",
  });
  return result;
};

/**
 * Trần độ dài khoảng ngày (bước 5, access-control-hardening).
 *
 * Vì sao cần: `getSnapshotReport` nạp TOÀN BỘ event trong khoảng vào RAM (`cursor.toArray()`), và
 * `dateRange` trước đây không được kiểm gì cả — một request `["2000-01-01","2100-01-01"]` là đủ để
 * kéo cả collection vào bộ nhớ tiến trình. Đo trên DB local: `avgObjSize` của `events` là ~1.2KB,
 * nên số document mới là biến quyết định, không phải kích thước khoảng ngày trên giấy.
 *
 * 90 ngày = 1 quý, đủ cho mọi biểu đồ mà trang Overview đang vẽ.
 */
export const MAX_SNAPSHOT_RANGE_DAYS = 90;

const DAY_MS = 86_400_000;

/**
 * Hàm THUẦN, export riêng để unit test không cần Mongo/socket.
 *
 * Ngoài việc chặn khoảng quá dài, nó còn đóng một lỗi runtime thật: `dateRange[0]` trước đây được
 * đọc NGOÀI khối `try`, nên payload thiếu/sai kiểu (client tự gọi socket) ném TypeError ngay trong
 * handler — không ai bắt, thành `unhandledRejection` toàn cục thay vì một phản hồi lỗi tử tế.
 */
type SnapshotRange = {
  ok: boolean;
  fromDate?: string;
  toDate?: string;
  error?: string;
};

// Kiểu là 1 object shape chứ KHÔNG phải discriminated union `{ok:true,...} | {ok:false,...}`:
// `tsconfig.json` của repo tắt `strict` (do đó tắt `strictNullChecks`), và khi thiếu
// `strictNullChecks` thì TS không narrow được union theo discriminant boolean — `range.error` sau
// `if (!range.ok)` báo TS2339. Union chặt chẽ hơn về mặt kiểu, nhưng chỉ dùng được sau khi cả repo
// bật `strict`; ở đây ưu tiên khớp cấu hình hiện có thay vì thêm 2 lỗi type mới.
export const parseSnapshotDateRange = (dateRange: unknown): SnapshotRange => {
  if (!Array.isArray(dateRange) || dateRange.length !== 2) {
    return { ok: false, error: "dateRange phải là mảng [from, to]" };
  }
  const [fromDate, toDate] = dateRange;
  const start = new Date(fromDate as any);
  const end = new Date(toDate as any);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { ok: false, error: "dateRange chứa ngày không hợp lệ" };
  }
  if (start.getTime() > end.getTime()) {
    return { ok: false, error: "from phải <= to" };
  }
  // `+1`: khoảng [ngày X, ngày X] là 1 ngày, không phải 0.
  const spanDays = Math.floor((end.getTime() - start.getTime()) / DAY_MS) + 1;
  if (spanDays > MAX_SNAPSHOT_RANGE_DAYS) {
    return {
      ok: false,
      error: `Khoảng ngày tối đa ${MAX_SNAPSHOT_RANGE_DAYS} ngày (yêu cầu ${spanDays} ngày)`,
    };
  }
  return { ok: true, fromDate: String(fromDate), toDate: String(toDate) };
};

export default class AnalyticsController {
  static async getSnapshotReport(payload: any, cb: Function) {
    const range = parseSnapshotDateRange(payload?.dateRange);
    if (!range.ok) {
      logger.warn({ dateRange: payload?.dateRange }, "[analytics] dateRange bị từ chối");
      if (typeof cb === "function") cb({ error: range.error });
      return;
    }
    const { fromDate, toDate } = range;
    const dateRangeArr = getDatesInRange(fromDate, toDate);

    try {
      const table = getCollection("events");

      const rangeStart = new Date(fromDate);
      const rangeEnd = new Date(toDate);
      rangeEnd.setHours(23, 59, 59, 999);

      // Include all fields needed by the processing functions
      const cursor = table.find(
        {
          createdAt: { $gte: rangeStart, $lte: rangeEnd },
        },
        {
          projection: {
            createdAt: 1,
            userId: 1,
            deviceInfo: 1,
            localeInfo: 1,
            browserInfo: 1,
            event: 1,
          },
        }
      );

      const totalData = await cursor.toArray();

      // Process the data for different metrics
      const userActiveData = getUserActiveData(totalData, dateRangeArr);
      const userDeviceData = getUserDeviceData(totalData);
      const userLocaleData = getUserLocaleData(totalData);
      const eventsData = getEventsData(totalData);
      const userOSData = getUserOS(totalData);

      // Return the processed data
      if (typeof cb !== "function") return;
      cb({
        active: userActiveData,
        device: userDeviceData,
        locale: userLocaleData,
        event: eventsData,
        os: userOSData,
      });
    } catch (error) {
      logger.error({ err: error }, "Error fetching analytics data");
      if (typeof cb === "function") cb({ error: "Failed to retrieve analytics data" });
    }
  }

  // Add a method for cached reporting
  static cachedReports = new Map();
  static cacheExpiryTime = 5 * 60 * 1000; // 5 minutes

  static async getCachedSnapshotReport(payload: any, cb: Function) {
    // Validate TRƯỚC khi dựng cacheKey: `dateRange[0]` trên payload dị dạng ném TypeError, và một
    // key dựng từ input chưa kiểm còn làm hỏng cả bộ nhớ cache.
    const range = parseSnapshotDateRange(payload?.dateRange);
    if (!range.ok) {
      if (typeof cb === "function") cb({ error: range.error });
      return;
    }
    const cacheKey = `${range.fromDate}_${range.toDate}`;

    // Check if we have a valid cached result
    const cachedItem = this.cachedReports.get(cacheKey);
    if (
      cachedItem &&
      Date.now() - cachedItem.timestamp < this.cacheExpiryTime
    ) {
      return cb(cachedItem.data);
    }

    // If no valid cache, get new data and cache it
    this.getSnapshotReport(payload, (data) => {
      this.cachedReports.set(cacheKey, {
        timestamp: Date.now(),
        data,
      });
      cb(data);
    });
  }
}
