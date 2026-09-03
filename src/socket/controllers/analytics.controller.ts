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

export const MAX_SNAPSHOT_RANGE_DAYS = 90;

const DAY_MS = 86_400_000;

type SnapshotRange = {
  ok: boolean;
  fromDate?: string;
  toDate?: string;
  error?: string;
};

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

      const userActiveData = getUserActiveData(totalData, dateRangeArr);
      const userDeviceData = getUserDeviceData(totalData);
      const userLocaleData = getUserLocaleData(totalData);
      const eventsData = getEventsData(totalData);
      const userOSData = getUserOS(totalData);

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

  static cachedReports = new Map();
  static cacheExpiryTime = 5 * 60 * 1000;

  static async getCachedSnapshotReport(payload: any, cb: Function) {
    const range = parseSnapshotDateRange(payload?.dateRange);
    if (!range.ok) {
      if (typeof cb === "function") cb({ error: range.error });
      return;
    }
    const cacheKey = `${range.fromDate}_${range.toDate}`;

    const cachedItem = this.cachedReports.get(cacheKey);
    if (
      cachedItem &&
      Date.now() - cachedItem.timestamp < this.cacheExpiryTime
    ) {
      return cb(cachedItem.data);
    }

    this.getSnapshotReport(payload, (data) => {
      this.cachedReports.set(cacheKey, {
        timestamp: Date.now(),
        data,
      });
      cb(data);
    });
  }
}
