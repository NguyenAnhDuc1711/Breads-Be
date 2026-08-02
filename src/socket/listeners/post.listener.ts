import { Server, Socket } from "socket.io";
import { POST_PATH, Route } from "../../Breads-Shared/APIConfig.js";
import PostController from "../controllers/post.controller.js";

const PostListener = (socket: Socket, io: Server) => {
  socket.on(Route.POST + POST_PATH.LIKE, (payload: any) =>
    PostController.likePost(payload, socket, io)
  );
};

export default PostListener;
