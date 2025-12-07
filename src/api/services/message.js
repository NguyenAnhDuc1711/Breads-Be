import Conversation from "../models/conversation.model.js";
import { ObjectId, destructObjectId } from "../../utils/index.js";

export const getConversationInfo = async ({ conversationId, userId }) => {
  try {
    const data = await Conversation.findOne({
      _id: ObjectId(conversationId),
    })
      .populate({
        path: "participants",
        select: "_id username avatar",
      })
      .populate({
        path: "lastMsgId",
        select: "_id content media files sender createdAt",
      })
      .lean();
    if (!!data) {
      const result = JSON.parse(JSON.stringify(data));
      const participant = result.participants.filter(
        ({ _id }) => destructObjectId(_id) !== userId
      );
      result.participant = participant[0];
      result.lastMsg = result.lastMsgId;
      delete result.participants;
      delete result.lastMsgId;
      return result;
    }
    return null;
  } catch (err) {
    console.log("getConversationInfo: ", err);
    throw new Error(err);
  }
};
