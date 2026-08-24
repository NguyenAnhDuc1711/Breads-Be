import Conversation from "../models/conversation.model.js";
import { ObjectId, destructObjectId } from "../../utils/index.js";
import { stripEmptyOptionalFields } from "../../utils/emptyFieldFilter.ts";
import logger from "../../core/logger.js";

export const REQUIRED_MESSAGE_FIELDS: ReadonlySet<string> = new Set([
  "_id",
  "conversationId",
  "sender",
  "createdAt",
]);

export const REQUIRED_CONVERSATION_FIELDS: ReadonlySet<string> = new Set([
  "_id",
  "participant",
  "createdAt",
  "updatedAt",
]);

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
        select: "_id conversationId content media files sender createdAt",
      })
      .lean();
    if (!!data) {
      const result = JSON.parse(JSON.stringify(data));
      const participant = result.participants.filter(
        ({ _id }) => destructObjectId(_id) !== userId
      );
      result.participant = participant[0];
      result.lastMsg = result.lastMsgId
        ? stripEmptyOptionalFields(result.lastMsgId, REQUIRED_MESSAGE_FIELDS)
        : undefined;
      delete result.participants;
      delete result.lastMsgId;
      return stripEmptyOptionalFields(result, REQUIRED_CONVERSATION_FIELDS);
    }
    return null;
  } catch (err) {
    logger.error({ err }, "getConversationInfo failed");
    throw new Error(err);
  }
};

