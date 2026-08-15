import { Server, Socket } from "socket.io";
import { MESSAGE_PATH, Route } from "../../Breads-Shared/APIConfig.js";
import MessageController from "../controllers/message.controller.js";

const MessageListener = (socket: Socket, io: Server) => {
  socket.on(
    Route.MESSAGE + MESSAGE_PATH.CREATE,
    (payload: any, cb: Function) => {
      MessageController.sendMessage(payload, cb, socket, io);
    }
  );
  socket.on(
    Route.MESSAGE + MESSAGE_PATH.GET_CONVERSATIONS,
    (payload: any, cb: Function) => {
      MessageController.getConversations(payload, cb, socket);
    }
  );
  socket.on(
    Route.MESSAGE + MESSAGE_PATH.GET_MESSAGES,
    (payload: any, cb: Function) => {
      MessageController.getMessages(payload, cb, socket);
    }
  );
  socket.on(
    Route.MESSAGE + MESSAGE_PATH.GET_MSGS_BY_SEARCH,
    (payload: any, cb: Function) => {
      MessageController.getMsgsToSearchMsg(payload, cb, socket);
    }
  );
  socket.on(
    Route.MESSAGE + MESSAGE_PATH.REACT,
    (payload: any, cb: Function) => {
      MessageController.reactMsg(payload, cb, socket, io);
    }
  );
  socket.on(
    Route.MESSAGE + MESSAGE_PATH.CONFIG_CONVERSATION,
    (payload: any, cb: Function) => {
      MessageController.changeSettingConversation(payload, cb, socket, io);
    }
  );
  socket.on(
    Route.MESSAGE + MESSAGE_PATH.RETRIEVE,
    (payload: any, cb: Function) => {
      MessageController.retrieveMsg(payload, cb, socket, io);
    }
  );
  socket.on(
    Route.MESSAGE + MESSAGE_PATH.SEEN_MSGS,
    (payload: any, cb: Function) => {
      MessageController.updateLastSeen(payload, cb, socket, io);
    }
  );
  socket.on(
    Route.MESSAGE + MESSAGE_PATH.SEND_NEXT,
    (payload: any, cb: Function) => {
      MessageController.sendNext(payload, cb, socket, io);
    }
  );
};

export default MessageListener;
