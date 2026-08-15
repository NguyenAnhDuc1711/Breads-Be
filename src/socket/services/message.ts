import { Server } from "socket.io";
import { getUserSocketByUserId } from "./user.js";
import logger from "../../core/logger.js";

export const sendToSpecificUser = async ({
  recipientId,
  io,
  path,
  payload,
}: {
  recipientId: string | any;
  io: Server;
  path: string;
  payload: any;
}) => {
  try {
    if (!recipientId || !io) {
      return;
    }
    const targetRoom = `user:${String(recipientId)}`;
    io.to(targetRoom).emit(path, payload);
  } catch (err) {
    logger.error({ err }, "sendToSpecificUser failed");
  }
};
