import mongoose from "mongoose";

export const getCollection = (name: string) => {
  const db = mongoose.connection.db;

  if (!db) {
    throw new Error("MongoDB: Can not get Collection");
  }

  return db.collection(name);
};

export const getAnalyticsDateCollection = async (collectionName: string) => {
  try {
    const analytic_db = process.env.ANALYTICS_DB_URI;
    if (analytic_db) {
      const analyticsDB = mongoose.createConnection(analytic_db);
      const collection = await analyticsDB.collection(collectionName);
      return collection;
    }
  } catch (err) {
    console.error("Connect error: ", err);
  }
};

export const ObjectId = (_id: any = null) => {
  if (!mongoose.isValidObjectId(_id) || !_id) {
    return new mongoose.Types.ObjectId();
  }
  return new mongoose.Types.ObjectId(_id);
};

export const destructObjectId = (objectId: any) => {
  return JSON.parse(JSON.stringify(objectId).replace("new ObjectId", ""));
};

export const formatDate = (date: Date) => {
  let day: string | number = date.getDate();
  let month: string | number = date.getMonth() + 1; // Months are zero-indexed
  let year: string | number = date.getFullYear();

  // Ensure day and month are always two digits
  day = day < 10 ? "0" + day : day;
  month = month < 10 ? "0" + month : month;

  return `${day}-${month}-${year}`;
};

export const getDatesInRange = (startDate, endDate) => {
  //Date input format: YYYY-MM-DD
  const dateArray: string[] = [];
  let currentDate = new Date(startDate);

  while (currentDate <= new Date(endDate)) {
    dateArray.push(formatDate(currentDate));
    currentDate = addDays(currentDate, 1);
  }

  function addDays(date, days) {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
  }

  return dateArray;
};

export const getOSFromUserAgent = (userAgent: any) => {
  if (userAgent.includes("Windows NT 10.0")) return "Windows 10";
  if (userAgent.includes("Windows NT 6.2")) return "Windows 8";
  if (userAgent.includes("Windows NT 6.1")) return "Windows 7";
  if (userAgent.includes("Windows NT 6.0")) return "Windows Vista";
  if (userAgent.includes("Windows NT 5.1")) return "Windows XP";
  if (userAgent.includes("Macintosh")) return "Mac OS";
  if (userAgent.includes("Linux")) return "Linux";
  if (userAgent.includes("Android")) return "Android";
  if (userAgent.includes("like Mac OS X")) return "iOS";
  return "Unknown OS";
};

export const getCountKeyAnalyticValue = ({
  data,
  keyLayer1,
  keyLayer2,
}: {
  data: any,
  keyLayer1: string,
  keyLayer2?: string | null,
}) => {
  const result: any = {};
  data.forEach((event: any) => {
    const valueAsKey = !keyLayer2
      ? event?.[keyLayer1]
      : event?.[keyLayer1]?.[keyLayer2];
    const userId = destructObjectId(event.userId);
    if (!(valueAsKey in result)) {
      result[valueAsKey] = [userId];
    } else {
      const isValid = result[valueAsKey].find(
        (validUser) => validUser == userId
      );
      if (!isValid) {
        result[valueAsKey].push(userId);
      }
    }
  });
  Object.keys(result).forEach((key) => {
    result[key] = result[key].length;
  });
  return result;
};
