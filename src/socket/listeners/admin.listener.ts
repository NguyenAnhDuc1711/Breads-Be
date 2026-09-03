import { ANALYTICS_PATH, Route } from "../../Breads-Shared/APIConfig.js";
import { Constants } from "../../Breads-Shared/Constants/index.js";
import User from "../../api/models/user.model.js";
import logger from "../../core/logger.js";
import AnalyticsController from "../controllers/analytics.controller.js";
import { Server, Socket } from "socket.io";

// Khớp với khai báo ROUTE_ROLES["/"] (trang Overview) của Breads-Admin — 2 nơi này KHÔNG tự đồng bộ
// (xem comment trong `Breads-Admin/src/config/routes.ts`), enforce thật nằm ở đây.
const SNAPSHOT_ROLES = [
  Constants.USER_ROLE.ADMIN,
  Constants.USER_ROLE.MODERATOR,
];

/**
 * Bước 5 (access-control-hardening): guard cho event analytics qua socket.
 *
 * TRƯỚC ĐÂY listener này gọi thẳng `AnalyticsController.getSnapshotReport` — không kiểm danh tính,
 * không kiểm role. Middleware handshake (`socket.ts`) CHO PHÉP kết nối ẩn danh (`next()` cả khi
 * verify JWT thất bại), nên bất kỳ ai mở WebSocket tới server cũng lấy được toàn bộ báo cáo
 * analytics: user active, device, locale, OS, event (probe V6 xác nhận nhận được payload thật).
 *
 * Vì sao phải query DB thay vì đọc role từ token: JWT chỉ mang `userId` (xem
 * `utils/generateTokens.ts` — `jwt.sign({ userId })`), không có `role`. Đây cũng đúng cách
 * `protectRoute` + `requireRole` làm ở phía REST.
 *
 * Không bao giờ throw: mọi lỗi tra cứu đều quy về "không đủ quyền" (default-deny), vì một exception
 * trong handler socket không có ai bắt sẽ thành `unhandledRejection` toàn cục.
 */
const hasSnapshotAccess = async (socket: Socket): Promise<boolean> => {
  const userId = (socket as any)?.user?.userId;
  if (!userId) return false;
  try {
    const user: any = await User.findById(userId, { role: 1 }).lean();
    return !!user && SNAPSHOT_ROLES.includes(user.role);
  } catch (err) {
    logger.error({ err, userId }, "[analytics] role lookup failed — từ chối truy cập");
    return false;
  }
};

// `_io` giữ nguyên vị trí tham số cho khớp chữ ký 4 listener còn lại (`socket.ts` gọi cả 5 theo
// cùng dạng `Listener(socket, io)`); tiền tố `_` để `noUnusedParameters` không báo lỗi.
const AnalyticsListener = (socket: Socket, _io: Server) => {
  socket.on(
    Route.ANALYTICS + ANALYTICS_PATH.GET_SNAPSHOT_REPORT,
    async (payload: any, cb: Function) => {
      if (!(await hasSnapshotAccess(socket))) {
        logger.warn(
          {
            socketId: socket.id,
            userId: (socket as any)?.user?.userId ?? null,
          },
          "[analytics] snapshot request bị từ chối — không đủ quyền"
        );
        // `cb` là ack callback do client cung cấp, có thể vắng mặt (client `emit` không kèm ack).
        // Gọi thẳng `cb(...)` khi nó undefined sẽ ném TypeError ngay trong handler socket.
        if (typeof cb === "function") cb({ error: "Forbidden" });
        return;
      }
      AnalyticsController.getSnapshotReport(payload, cb);
    }
  );
};

export default AnalyticsListener;
