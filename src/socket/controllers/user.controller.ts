import { Server, Socket } from "socket.io";
import { getFriendsSocketInfo } from "../services/user.js";
import logger from "../../core/logger.js";

export default class UserController {
  static connect = async (payload: any, socket: Socket, io: Server) => {
    try {
      const { userFollowed, userFollowing } = payload ?? {};
      const authUserId = (socket as any).user?.userId;
      if (!authUserId) {
        logger.warn(
          { socketId: socket.id, claimedUserId: payload?.userId },
          "user/connect without authenticated identity"
        );
        return;
      }
      socket.data = {
        id: socket.id,
        userId: authUserId,
        userFollowed,
        userFollowing,
        friendsInfo: [],
      };
      const friendsSocketInfo = await getFriendsSocketInfo(io, socket);
      socket.data.friendsInfo = friendsSocketInfo;
    } catch (err) {
      logger.error({ err, socketId: socket?.id }, "UserController.connect failed");
    }
  };
}
