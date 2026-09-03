import { Constants } from "../Breads-Shared/Constants/index.js";

/**
 * Bước 6 (access-control-hardening) — nguồn sự thật DUY NHẤT cho câu hỏi "tài khoản này có bị
 * chặn không", dùng chung bởi cả 3 điểm enforce: `loginUser`, `protectRoute` (REST) và middleware
 * handshake của Socket.IO. Ba nơi tự viết điều kiện riêng là cách chắc chắn nhất để chúng lệch nhau.
 *
 * CHỈ `LOCK` và `BANNED` mới là trạng thái kiểm duyệt. `ACTIVE`/`INACTIVE` là trạng thái HIỆN DIỆN
 * (online/offline) — xem nhãn trong `Breads-Admin/src/pages/UsersPage.tsx:409-412` ("Online"/
 * "Offline") và cách `UserDetailPage.tsx:206-208` gom đúng LOCK+BANNED thành `isLockedOrBanned`.
 * Chặn nhầm `INACTIVE` sẽ khoá cửa mọi user đang offline — một sự cố toàn hệ thống đội lốt bản vá
 * bảo mật.
 */
export const RESTRICTED_USER_STATUSES: number[] = [
  Constants.USER_STATUS.LOCK,
  Constants.USER_STATUS.BANNED,
];

/**
 * `status` vắng mặt / không phải số -> KHÔNG bị chặn.
 *
 * Có chủ đích: document user cũ (trước khi field `status` tồn tại) không có key này trên đĩa, và
 * mặc định của Mongoose không áp lúc đọc. Fail-open ở ĐÚNG chỗ này là lựa chọn đúng — nhầm hướng
 * kia nghĩa là mọi tài khoản legacy bị khoá vĩnh viễn.
 */
export const isAccountRestricted = (status: unknown): boolean => {
  const value = Number(status);
  if (!Number.isFinite(value)) return false;
  return RESTRICTED_USER_STATUSES.includes(value);
};

/** Mã máy-đọc-được cho client (Fe điều hướng sang `/banned`), tách khỏi message hiển thị. */
export const ACCOUNT_RESTRICTED_CODE = "ACCOUNT_RESTRICTED";
