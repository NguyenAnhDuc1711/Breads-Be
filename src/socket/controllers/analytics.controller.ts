import {
  destructObjectId,
  formatDate,
  getAnalyticsDateCollection,
  getCountKeyAnalyticValue,
  getDatesInRange,
  getOSFromUserAgent,
} from "../../utils/index.js";

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

export default class AnalyticsController {
  static async getSnapshotReport(payload: any, cb: Function) {
    const { dateRange } = payload;
    const fromDate = dateRange[0];
    const toDate = dateRange[1];
    const dateRangeArr = getDatesInRange(fromDate, toDate);

    try {
      // Process collections in parallel using Promise.all
      const dataPromises = dateRangeArr.map(async (date) => {
        const table = await getAnalyticsDateCollection(date);
        if (!table) return [];

        // Include all fields needed by the processing functions
        const cursor = await table.find(
          {},
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

        return cursor.toArray();
      });

      // Wait for all queries to complete in parallel
      const results = await Promise.all(dataPromises);

      // Flatten the array of arrays
      const totalData = results.flat();

      // Process the data for different metrics
      const userActiveData = getUserActiveData(totalData, dateRangeArr);
      const userDeviceData = getUserDeviceData(totalData);
      const userLocaleData = getUserLocaleData(totalData);
      const eventsData = getEventsData(totalData);
      const userOSData = getUserOS(totalData);

      // Return the processed data
      cb({
        active: userActiveData,
        device: userDeviceData,
        locale: userLocaleData,
        event: eventsData,
        os: userOSData,
      });
    } catch (error) {
      console.error("Error fetching analytics data:", error);
      cb({ error: "Failed to retrieve analytics data" });
    }
  }

  // Add a method for cached reporting
  static cachedReports = new Map();
  static cacheExpiryTime = 5 * 60 * 1000; // 5 minutes

  static async getCachedSnapshotReport(payload: any, cb: Function) {
    const { dateRange } = payload;
    const cacheKey = `${dateRange[0]}_${dateRange[1]}`;

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
