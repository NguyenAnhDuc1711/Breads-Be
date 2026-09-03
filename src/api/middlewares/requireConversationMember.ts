import HTTPStatus from "../../utils/httpStatus.js";
import logger from "../../core/logger.js";
import { ObjectId } from "../../utils/index.js";
import Conversation from "../models/conversation.model.js";

export const requireConversationMember = (
  source: "params" | "body" = "params",
  key = "conversationId"
) => {
  return async (req, res, next) => {
    const conversationId = req[source]?.[key];
    const userId = req.user?._id;
    if (!conversationId || !userId) {
      return res.status(HTTPStatus.FORBIDDEN).json({ message: "Forbidden" });
    }

    try {
      const member = await Conversation.exists({
        _id: ObjectId(String(conversationId)),
        participants: ObjectId(String(userId)),
      });
      if (!member) {
        logger.warn(
          { userId: String(userId), conversationId: String(conversationId) },
          "[conversation] truy cập bị từ chối — không phải thành viên"
        );
        return res.status(HTTPStatus.FORBIDDEN).json({ message: "Forbidden" });
      }
      next();
    } catch (err) {
      logger.error({ err }, "[conversation] membership check failed");
      return res.status(HTTPStatus.FORBIDDEN).json({ message: "Forbidden" });
    }
  };
};

export default requireConversationMember;
