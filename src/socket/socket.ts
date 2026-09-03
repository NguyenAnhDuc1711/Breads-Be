// import SocketListener from "../SocketRouters/index.js";
import { Server as HttpServer } from "http";
import { Application } from "express";
import { Server, Socket } from "socket.io";
import jwt from "jsonwebtoken";
import MessageListener from "./listeners/message.listener.js";
import NotificationListener from "./listeners/notification.listener.js";
import PostListener from "./listeners/post.listener.js";
import UserListener from "./listeners/user.listener.js";
import AnalyticsListener from "./listeners/admin.listener.js";
import ALLOWED_ORIGINS from "../utils/allowedOrigins.js";
import User from "../api/models/user.model.js";
import { isAccountRestricted } from "../utils/accountStatus.js";
import logger from "../core/logger.js";

const parseCookieString = (cookieHeader?: string): Record<string, string> => {
  if (!cookieHeader) return {};
  return Object.fromEntries(
    cookieHeader.split(";").map((c) => {
      const [key, ...v] = c.trim().split("=");
      return [key, v.join("=")];
    })
  );
};

import { createAdapter } from "@socket.io/redis-adapter";
import { getRedisInstance } from "../dbs/redis.js";

export const initSocket = (server: HttpServer, app: Application): void => {
  try {
    const io = new Server(server, {
      cors: {
        origin: ALLOWED_ORIGINS,
        credentials: true,
      },
      path: "/socket",
    });

    const redisClient = getRedisInstance();
    if (redisClient) {
      try {
        const pubClient = redisClient.duplicate();
        const subClient = redisClient.duplicate();
        io.adapter(createAdapter(pubClient, subClient));
        logger.info("Socket.IO Redis adapter enabled");
      } catch (adapterErr) {
        logger.warn(
          { err: adapterErr },
          "Failed to initialize Socket.IO Redis adapter, falling back to default adapter"
        );
      }
    }

    io.use(async (socket: Socket, next) => {
      try {
        // Primary: access token passed explicitly via handshake auth
        // Fallback: legacy jwt cookie (backward compat during transition)
        const cookies = parseCookieString(socket.handshake.headers.cookie);
        const token = socket.handshake.auth?.token || cookies.jwt;
        if (token && process.env.JWT_SECRET) {
          const decoded: any = jwt.verify(token, process.env.JWT_SECRET);

          // Bước 6 (V9): tầng socket là đường thứ HAI vào hệ thống, không đi qua `protectRoute`.
          // Chặn ban chỉ ở REST là để nguyên cửa nhắn tin/thông báo real-time cho tài khoản đã bị
          // cấm. 1 query cho mỗi lần KẾT NỐI (không phải mỗi event) — connection thưa hơn event
          // nhiều bậc, và `connection` handler bên dưới vốn đã chạm DB (`lastActiveAt`).
          //
          // Tài khoản bị hạn chế -> KHÔNG gắn `socket.user`, tức socket rơi về trạng thái ẩn danh:
          // mọi listener lấy danh tính từ `socket.user.userId` (message/notification/analytics) tự
          // fail-closed mà không cần sửa từng cái.
          const account: any = await User.findById(decoded?.userId, {
            status: 1,
          }).lean();
          if (account && isAccountRestricted(account.status)) {
            logger.warn(
              { userId: String(decoded?.userId), status: account.status },
              "[socket] handshake của tài khoản bị hạn chế — không gắn danh tính"
            );
          } else {
            (socket as any).user = decoded;
          }
        }
        next();
      } catch (err) {
        // Continue connection but without authenticated user attached
        next();
      }
    });

    app.set("socket_io", io);
    io.on("connection", async (socket: Socket) => {
      const socketUserId = (socket as any).user?.userId;
      if (socketUserId) {
        socket.join(`user:${socketUserId}`);
        User.updateOne(
          { _id: socketUserId },
          { lastActiveAt: new Date() }
        ).catch((err) =>
          logger.error({ err }, "Error updating lastActiveAt from socket")
        );
      }
      UserListener(socket, io);
      NotificationListener(socket, io);
      PostListener(socket, io);
      MessageListener(socket, io);
      AnalyticsListener(socket, io);
      socket.on("disconnect", async (message) => {
        // await disconnect(socket, io);
      });
    });
  } catch (err) {
    logger.error({ err }, "initSocket failed");
  }
};
