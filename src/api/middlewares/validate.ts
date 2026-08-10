// Middleware factory validate payload cho toàn bộ router (AD-1/AD-4/AD-6).
//
// Nhận 1 schema-bag `{ body?, query?, params? }` (mỗi route export ĐÚNG 1 const có shape này) và
// trả về 1 middleware Express.
//
// ĐỒNG BỘ 100% — dùng `.parse()` (không phải `.parseAsync()`), gọi `next(err)` trực tiếp, không bao
// giờ throw ra ngoài hoặc trả về Promise. Bắt buộc vì `post.route.ts` (`createPost`) và
// `util.route.ts` (`sendForgotPWMail`) KHÔNG được bọc `asyncHandler`: một middleware async throw sẽ
// treo request đó thay vì trả lỗi.
//
// Sau khi parse thành công, gán lại `req.body`/`req.query`/`req.params` bằng kết quả đã parse (và
// đã coerce) để controller nhận đúng kiểu mà không phải sửa lại cách đọc field ở cả 8 controller.
// Lưu ý: `z.object()` mặc định LOẠI BỎ key không khai báo — schema thiếu field nào thì field đó
// biến mất âm thầm sau validate (không phải 400). Người viết schema phải liệt kê đủ field mà cả
// controller LẪN tầng service dùng.
//
// Lỗi validate luôn trả về đúng 1 message hằng, generic (NFR-3) — chi tiết `issues` chỉ đi vào log
// server, không bao giờ vào response.
import { ZodError, type ZodSchema } from "zod";
import { BadRequestError } from "../../core/error.response.ts";
import logger from "../../core/logger.ts";

export const VALIDATION_ERROR_MESSAGE = "Invalid request payload";

type ValidateSchema = {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
};

export const validate = (schema: ValidateSchema) => (req, _res, next) => {
  try {
    if (schema.body) req.body = schema.body.parse(req.body);
    if (schema.query) req.query = schema.query.parse(req.query);
    if (schema.params) req.params = schema.params.parse(req.params);
    next();
  } catch (err) {
    if (err instanceof ZodError) {
      logger.warn(
        { issues: err.issues, path: req.path },
        "payload validation failed"
      );
      return next(new BadRequestError(VALIDATION_ERROR_MESSAGE));
    }
    next(err);
  }
};
