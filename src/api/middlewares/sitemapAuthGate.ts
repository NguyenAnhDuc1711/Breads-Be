import HTTPStatus from "../../utils/httpStatus.ts";

// Task 002 (epic seo-sitemap-schema, AD-3): shared-secret gate dùng chung cho MỌI endpoint
// "sitemap-eligible" (post ở task này, user ở task 003 import lại middleware này nguyên vẹn).
// Đây KHÔNG phải endpoint client app gọi — chỉ sitemap generator (server-to-server, chạy định kỳ)
// gọi -> auth bằng secret header thay vì JWT user session (giống pattern `optionalAuth`/
// `protectRoute`: trả thẳng `res.status(...).json({message})`, không throw `ErrorResponse`, để
// nhất quán với 2 middleware auth hiện có trong cùng thư mục).
//
// Header tên `x-sitemap-secret` (Node/Express luôn lowercase key trong `req.headers`, nên so sánh
// bằng chữ thường bất kể client gửi hoa/thường thế nào). Biến môi trường tương ứng:
// `SITEMAP_SHARED_SECRET`.
export const SITEMAP_SECRET_HEADER = "x-sitemap-secret";

const sitemapAuthGate = (req, res, next) => {
  const provided = req.headers[SITEMAP_SECRET_HEADER];
  const expected = process.env.SITEMAP_SHARED_SECRET;

  // Thiếu `expected` (env chưa cấu hình) cũng phải chặn — không được "mở toang" endpoint chỉ vì
  // thiếu config, đó vẫn là lỗi phía server, không phải lý do để bỏ qua auth.
  if (!expected || !provided || provided !== expected) {
    return res.status(HTTPStatus.UNAUTHORIZED).json({ message: "Unauthorized" });
  }

  next();
};

export default sitemapAuthGate;
