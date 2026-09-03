import { ANALYTICS_PATH, Route } from "../../Breads-Shared/APIConfig.js";
import { Constants } from "../../Breads-Shared/Constants/index.js";
import User from "../../api/models/user.model.js";
import logger from "../../core/logger.js";
import AnalyticsController from "../controllers/analytics.controller.js";
import { Server, Socket } from "socket.io";

const SNAPSHOT_ROLES = [
  Constants.USER_ROLE.ADMIN,
  Constants.USER_ROLE.MODERATOR,
];

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
        if (typeof cb === "function") cb({ error: "Forbidden" });
        return;
      }
      AnalyticsController.getSnapshotReport(payload, cb);
    }
  );
};

export default AnalyticsListener;
