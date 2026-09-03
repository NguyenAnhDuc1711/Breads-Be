import mongoose from "mongoose";

export const getCollection = (name: string) => {
  const db = mongoose.connection.db;

  if (!db) {
    throw new Error("MongoDB: Can not get Collection");
  }

  return db.collection(name);
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

/**
 * Escape mọi ký tự đặc biệt của regex trong chuỗi do NGƯỜI DÙNG nhập, trước khi đưa vào `$regex`.
 *
 * Vì sao bắt buộc (finding A5, `docs/architecture-review.md`, mở từ 2026-08-10):
 *
 *   1. **ReDoS** — input đi thẳng vào `$regex` nghĩa là người dùng viết được CHƯƠNG TRÌNH regex,
 *      không chỉ từ khoá tìm kiếm. Một chuỗi như `(a+)+$` gây catastrophic backtracking: máy chủ
 *      quay cuồng CPU trên MỘT request.
 *   2. **Sai kết quả im lặng** — `.` `*` `?` `[` `(` trong câu tìm kiếm bình thường của người dùng
 *      hiện đang được diễn giải là cú pháp regex, nên "a.b" khớp cả "axb".
 *
 * `[.*+?^${}()|[\]\\]` là tập ký tự đặc biệt đầy đủ của JS RegExp; `\\$&` chèn `\` trước ký tự
 * khớp được.
 */
export const escapeRegex = (input: unknown): string =>
  String(input ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
