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

const parseCookieString = (cookieHeader?: string): Record<string, string> => {
  if (!cookieHeader) return {};
  return Object.fromEntries(
    cookieHeader.split(";").map((c) => {
      const [key, ...v] = c.trim().split("=");
      return [key, v.join("=")];
    })
  );
};

export const initSocket = (server: HttpServer, app: Application): void => {
  try {
    const io = new Server(server, {
      cors: {
        origin: ALLOWED_ORIGINS,
        credentials: true,
      },
      path: "/socket",
    });

    io.use((socket: Socket, next) => {
      try {
        const cookies = parseCookieString(socket.handshake.headers.cookie);
        const token = cookies.jwt || socket.handshake.auth?.token;
        if (token && process.env.JWT_SECRET) {
          const decoded = jwt.verify(token, process.env.JWT_SECRET);
          (socket as any).user = decoded;
        }
        next();
      } catch (err) {
        // Continue connection but without authenticated user attached
        next();
      }
    });

    app.set("socket_io", io);
    io.on("connection", async (socket: Socket) => {
      console.log("Server is connected with socket ", socket.id);
      const socketUserId = (socket as any).user?.userId;
      if (socketUserId) {
        User.updateOne(
          { _id: socketUserId },
          { lastActiveAt: new Date() }
        ).catch((err) =>
          console.log("Error updating lastActiveAt from socket", err.message)
        );
      }
      UserListener(socket, io);
      NotificationListener(socket, io);
      PostListener(socket, io);
      MessageListener(socket, io);
      AnalyticsListener(socket, io);
      socket.on("disconnect", async (message) => {
        console.log("Socket disconnected");
        // await disconnect(socket, io);
      });
    });
  } catch (err) {
    console.log(err);
  }
};
