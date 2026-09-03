import HTTPStatus from "../../utils/httpStatus.js";
import { ForbiddenError } from "../../core/error.response.js";

// Factory, not a bare middleware — must run AFTER protectRoute (reads
// req.user set by it). Default-deny: missing/unrecognized role is always
// treated as insufficient, never allowed through.
export const requireRole = (...roles: number[]) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(HTTPStatus.FORBIDDEN).json({ message: "Forbidden" });
    }
    next();
  };
};

// Variant for endpoints shared between self-service (any user acting on
// their own resource, identified by a path param) and admin override
// (acting on someone else's resource). Must run AFTER protectRoute.
//
// Bước 4 (access-control-hardening): tên param trở thành tham số vì router
// `collection` dùng `:userId` chứ không phải `:id`. Gọi KHÔNG kèm role nào
// (`requireSelfOnParam("userId")`) nghĩa là self-only: `roles` rỗng thì
// `roles.includes(...)` luôn false, nên chỉ chính chủ đi qua được.
export const requireSelfOnParam = (paramName: string, ...roles: number[]) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(HTTPStatus.FORBIDDEN).json({ message: "Forbidden" });
    }
    const isSelf = req.user._id?.toString() === req.params[paramName];
    if (!isSelf && !roles.includes(req.user.role)) {
      return res.status(HTTPStatus.FORBIDDEN).json({ message: "Forbidden" });
    }
    next();
  };
};

// Giữ nguyên signature cũ (param `id`) để 3 call site sẵn có trong
// `user.route.ts` không phải đổi.
export const requireSelfOrRole = (...roles: number[]) =>
  requireSelfOnParam("id", ...roles);


/**
 * Bản dùng TRONG CONTROLLER của `requireRole` — cùng một vị từ, khác cơ chế báo lỗi (throw để
 * `asyncHandler` bắt, thay vì tự ghi response).
 *
 * Bước 10 (access-control-hardening): 5 controller trước đây tự kiểm quyền bằng cách
 * `User.findOne({_id: req.body.userId})` rồi xét `role` của document đó. Hai vấn đề:
 *
 *   1. `userId` do CLIENT gửi -> thứ được kiểm là quyền của người mà KẺ GỌI chỉ định, không phải
 *      quyền của kẻ gọi. Hiện không khai thác được vì `requireRole` ở tầng route chạy trước và mới
 *      là biên thật — nhưng nó TRÔNG như một lớp kiểm quyền, nên ai gỡ `requireRole` khỏi route sẽ
 *      tưởng controller vẫn còn canh.
 *   2. Tốn 1 query DB mỗi request, hoàn toàn thừa: `protectRoute` vừa `User.findById(...)
 *      .select("-password")` xong và gán vào `req.user` — `role` ĐÃ có sẵn trong bộ nhớ.
 *
 * Giữ lại lớp kiểm này (thay vì xoá hẳn) vì giờ nó thực sự là phòng thủ nhiều lớp: không tốn gì
 * thêm, và dùng chung vị từ với `requireRole` nên 2 lớp không thể lệch nhau.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * BẤT BIẾN BẮT BUỘC: `user` phải là `req.user` do `protectRoute` gán — tức là DOCUMENT TỪ DB
 * (`User.findById(userId).select("-password")`), KHÔNG phải payload của JWT.
 *
 * Token chỉ chứa `{ userId }` (`generateTokens.ts:28` — `jwt.sign({ userId }, ...)`), KHÔNG có
 * `role`. Nên:
 *
 *   - `assertRole(req.user, ...)`      ✅ đúng — `req.user.role` đến từ DB
 *   - `assertRole(socket.user, ...)`   ❌ SAI — `socket.user` LÀ payload JWT đã decode
 *                                         (`socket/socket.ts`), `role` sẽ luôn `undefined`
 *
 * Gọi sai KHÔNG tạo lỗ hổng (fail-closed: `undefined` không nằm trong `roles` nên bị từ chối),
 * nhưng sẽ khoá cửa TẤT CẢ mọi người kể cả admin — một sự cố tính năng rất khó truy vì code đọc
 * hoàn toàn hợp lý. Tầng socket muốn kiểm role phải tự tra DB: xem `hasSnapshotAccess` trong
 * `socket/listeners/admin.listener.ts`, nơi đã làm đúng vì lý do này.
 *
 * Bất biến trên được kiểm bằng probe R19/R20 (`test/security/access-control-probe.ts`) đi qua
 * `protectRoute` THẬT — mọi unit test của `assertRole` đều stub `req.user` nên tự chúng không
 * chứng minh được điều này.
 * ────────────────────────────────────────────────────────────────────────────────────────────
 */
export const assertRole = (user: any, ...roles: number[]): void => {
  if (!user || !roles.includes(user.role)) {
    throw new ForbiddenError();
  }
};

export default requireRole;
