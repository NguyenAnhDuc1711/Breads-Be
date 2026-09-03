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

export const getUserSocketsByUserIds = async (
  userIds: (string | any)[],
  io: Server
): Promise<string[]> => {
  const wanted = new Set(
    (userIds || []).filter(Boolean).map((id) => String(id))
  );
  if (!wanted.size) return [];
  const listSocket = await getAllSockets(io);
  return (listSocket || [])
    .map((sk) => sk.data as SocketData)
    .filter((d) => d?.userId && wanted.has(String(d.userId)))
    .map((d) => d.id);
};

export const getUserSocketByUserId = async (
  userId: string,
  io: Server
): Promise<string | undefined> =>
  (await getUserSocketsByUserIds([userId], io))[0];
