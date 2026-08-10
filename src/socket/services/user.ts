import { Server, Socket } from "socket.io";

interface SocketData {
  id: string;
  userId: string;
  userFollowed?: string[];
  userFollowing?: string[];
}

export const getAllSockets = async (io: Server) => {
  const sockets = await io?.fetchSockets();
  return sockets;
};

export const getFriendsSocketInfo = async (
  io: Server,
  socket: Socket
): Promise<{ socketId: string; userId: string }[]> => {
  const socketData = socket.data as SocketData;
  const userFollowed = socketData?.userFollowed || [];
  const userFollowing = socketData?.userFollowing || [];
  const friendsId = userFollowed.filter((userId) =>
    userFollowing.includes(userId)
  );

  if (friendsId.length) {
    const listSocket = await getAllSockets(io);
    const socketsData = listSocket.map((sk) => sk.data as SocketData);
    const friendsSocket = socketsData.filter((socket) =>
      friendsId.includes(socket.userId)
    );

    if (friendsSocket.length) {
      const friendsSocketInfo = friendsSocket.map((socket) => ({
        socketId: socket.id,
        userId: socket.userId,
      }));
      return friendsSocketInfo;
    }
  }
  return [];
};

export const getUserSocketByUserId = async (
  userId: string,
  io: Server
): Promise<string | undefined> => {
  const listSocket = await getAllSockets(io);
  const socketsData = listSocket.map((sk) => sk.data as SocketData);
  const userSocketId = socketsData.find(
    (socket) => socket.userId === userId.toString()
  )?.id;
  return userSocketId;
};
