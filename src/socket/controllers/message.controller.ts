import axios from "axios";
import mongoose from "mongoose";
import { Server, Socket } from "socket.io";
import Conversation from "../../api/models/conversation.model.js";
import Link from "../../api/models/link.model.js";
import Message from "../../api/models/message.model.js";
import User from "../../api/models/user.model.js";
import { getConversationInfo } from "../../api/services/message.js";
import { uploadFileFromBase64 } from "../../api/utils/index.js";
import { MESSAGE_PATH, Route } from "../../Breads-Shared/APIConfig.js";
import { Constants } from "../../Breads-Shared/Constants/index.js";
import { isMediaLegacyFallbackEnabled } from "../../api/services/mediaConvention.js";
import { validateMediaUrl } from "../../api/validators/validateMediaUrl.js";
import { ObjectId, destructObjectId } from "../../utils/index.js";
import { sendToSpecificUser } from "../services/message.js";
import logger from "../../core/logger.js";
import {
  messageSendLimiter,
  messageActionLimiter,
  messageQueryLimiter,
} from "../middlewares/rateLimiter.js";
import {
  sanitizeText,
  sanitizeNoSqlPayload,
  checkPayloadSize,
  sendMessageSchema,
  getConversationsSchema,
  getMessagesSchema,
  getMsgsToSearchMsgSchema,
  reactMsgSchema,
  changeSettingConversationSchema,
  retrieveMsgSchema,
  updateLastSeenSchema,
  sendNextSchema,
} from "../validators/message.validator.js";

const { TEXT, MEDIA, FILE, SETTING } = Constants.MSG_TYPE;
const previewLinkKey = (process.env.LINKPREVIEW_API_KEYS ?? "")
  .split(",")
  .map((key) => key.trim())
  .filter(Boolean);

export default class MessageController {
  static async sendMessage(payload: any, cb: Function, socket: Socket, io: Server) {
    try {
      const authUserId = (socket as any)?.user?.userId;
      if (!authUserId) {
        logger.warn({ socketId: socket?.id }, "sendMessage rejected: unauthenticated");
        cb?.({ status: "error", message: "Unauthorized", data: [] });
        return;
      }

      // 1. Rate limiting check (max 5 msgs/sec)
      const rateCheck = messageSendLimiter.check(authUserId);
      if (!rateCheck.allowed) {
        cb?.({
          status: "error",
          message: "Too many messages sent. Please slow down.",
          code: "RATE_LIMIT_EXCEEDED",
          data: [],
        });
        return;
      }

      // 2. Payload size check (max 25MB)
      if (!checkPayloadSize(payload, 25 * 1024 * 1024)) {
        cb?.({
          status: "error",
          message: "Payload size exceeds 25MB limit",
          code: "PAYLOAD_TOO_LARGE",
          data: [],
        });
        return;
      }

      // 3. Sanitize NoSQL operators
      const cleanPayload = sanitizeNoSqlPayload(payload);

      // 4. Schema validation
      const validation = sendMessageSchema.safeParse(cleanPayload);
      if (!validation.success) {
        cb?.({
          status: "error",
          message: validation.error.issues[0]?.message || "Invalid message payload",
          data: [],
        });
        return;
      }

      const { recipientId, message } = validation.data;
      if (String(recipientId) === String(authUserId)) {
        logger.warn(
          { socketId: socket?.id, authUserId, recipientId },
          "sendMessage rejected: invalid recipient"
        );
        cb?.({ status: "error", message: "Invalid recipient", data: [] });
        return;
      }

      const senderId = authUserId;
      let conversation = await Conversation.findOne({
        participants: { $all: [ObjectId(senderId), ObjectId(recipientId)] },
      });

      const listMsgId: any[] = [];
      const listMsg: any[] = [];
      const { files, media, respondTo } = message;
      // Sanitize text content (remove dangerous script tags / control chars)
      const content = sanitizeText(message.content);

      const numberNewMsg =
        (files?.length || 0) + ((media?.length ?? 0) > 0 ? 1 : 0) + (content ? 1 : 0);

      if (numberNewMsg === 0) {
        cb?.({ status: "error", message: "Empty message", data: [] });
        return;
      }

      // FR-4 (cutover): media phải là URL Cloudinary hợp lệ, không còn nhận base64 mặc định.
      // Chạy TRƯỚC khi tạo/cập nhật conversation để 1 item không hợp lệ không để lại
      // `lastMsgId` trỏ tới message không bao giờ được insert.
      // Thứ tự check per-ITEM BẮT BUỘC (epic.md AD-4/AD-5): (1) GIF → bỏ qua validate;
      // (2) flag break-glass + `data:` → fallback base64 cũ; (3) else → validate strict.
      // Đảo (2) và (3) khiến flag thành dead code (bug AD5-1).
      let processedMedia: any[] = media ?? [];
      if (media?.length) {
        const sortedPairId = [String(senderId), String(recipientId)].sort().join("_");
        const checkedMedia = await Promise.all(
          media.map(async (m: any) => {
            const url = typeof m?.url === "string" ? m.url : "";

            // (1) Carve-out GIF ở cấp ITEM (AD-4) — GIF từ provider ngoài Cloudinary là hợp lệ,
            // bất kể batch có bao nhiêu item khác.
            if (
              typeof m?.type === "string" &&
              m.type.toLowerCase() === Constants.MEDIA_TYPE.GIF
            ) {
              return { valid: true, item: m };
            }

            // (2) Lối thoát khẩn cấp khi Be/Fe lệch deploy (AD-5), mặc định TẮT.
            if (isMediaLegacyFallbackEnabled() && url.startsWith("data:")) {
              const imgUrl = await uploadFileFromBase64({ base64: url });
              return {
                valid: true,
                item: { url: imgUrl ?? url, type: Constants.MEDIA_TYPE.IMAGE },
              };
            }

            // (3) Đường mặc định sau cutover.
            const valid = validateMediaUrl(url, {
              namespace: "message",
              expectedKey: sortedPairId,
            });
            return { valid, item: m };
          })
        );

        if (checkedMedia.some((m) => !m.valid)) {
          logger.warn(
            { socketId: socket?.id, authUserId },
            "sendMessage rejected: invalid media url"
          );
          cb?.({
            status: "error",
            message: "Invalid media URL. Upload media via the signed upload flow first.",
            code: "INVALID_MEDIA_URL",
            data: [],
          });
          return;
        }

        processedMedia = checkedMedia.map((m) => m.item);
      }

      for (let i = 0; i < numberNewMsg; i++) {
        listMsgId.push(ObjectId());
      }

      if (!conversation) {
        conversation = new Conversation({
          participants: [ObjectId(senderId), ObjectId(recipientId)],
          lastMsgId: listMsgId[listMsgId.length - 1],
        });
        await conversation.save();
      } else {
        await Conversation.updateOne(
          {
            _id: ObjectId(conversation._id),
          },
          {
            $set: {
              lastMsgId: listMsgId[listMsgId.length - 1],
            },
          }
        );
      }

      let currentFileIndex = 0;
      let addMedia = false;
      let isReplied = false;

      for (let index = 0; index < listMsgId.length; index++) {
        const _id = listMsgId[index];
        let newMsg: any = null;
        const msgInfo = {
          _id: _id,
          conversationId: conversation._id,
          sender: ObjectId(senderId),
        };

        if (content?.trim() && index === 0) {
          const urlRegex = /(https?:\/\/[^\s]+)/g;
          const urls = content.match(urlRegex);
          const links: any[] = [];
          try {
            if (urls?.length) {
              for (const url of urls) {
                let result: any = null;
                const previewLen = previewLinkKey?.length || 0;
                let kIdx = 1;
                try {
                  do {
                    const key = previewLinkKey[kIdx - 1];
                    try {
                      const { data } = await axios.get(
                        `https://api.linkpreview.net?key=${key}&q=${encodeURIComponent(url)}`
                      );
                      if (data) {
                        result = data;
                      }
                    } catch (err) {
                      kIdx += 1;
                    }
                  } while (kIdx <= previewLen && !result);
                } catch (err) {
                  logger.error({ err }, "getLinkPreview key rotation failed");
                }
                if (
                  typeof result === "object" &&
                  result !== null &&
                  Object.keys(result).length > 0
                ) {
                  links.push({
                    _id: ObjectId(),
                    ...result,
                  });
                }
              }
            }
          } catch (err) {
            logger.error({ err }, "getLinkPreview failed");
          }

          if (links.length > 0) {
            await Link.insertMany(links, { ordered: false });
          }

          newMsg = {
            ...msgInfo,
            content: content,
            links: links.map((l) => l._id),
            type: TEXT,
          };
          if (respondTo) {
            newMsg.respondTo = ObjectId(respondTo);
            isReplied = true;
          }
        } else if (media?.length && !addMedia) {
          newMsg = new Message({
            ...msgInfo,
            media: processedMedia,
            type: MEDIA,
          });
          if (respondTo && !isReplied) {
            newMsg.respondTo = ObjectId(respondTo);
            isReplied = true;
          }
          addMedia = true;
        } else if (
          files?.length &&
          (files.length > 1
            ? currentFileIndex < files.length - 1
            : currentFileIndex < files.length)
        ) {
          newMsg = new Message({
            ...msgInfo,
            file: files[currentFileIndex],
            type: FILE,
          });
          if (respondTo && !isReplied) {
            newMsg.respondTo = ObjectId(respondTo);
            isReplied = true;
          }
          currentFileIndex += 1;
        }

        if (newMsg) {
          listMsg.push(newMsg);
        }
      }

      await Message.insertMany(listMsg, { ordered: false });

      const newMessages = await Message.find({
        _id: { $in: listMsgId },
      })
        .populate({
          path: "file",
        })
        .populate({
          path: "links",
        })
        .populate({
          path: "respondTo",
        });

      const conversationInfo = await getConversationInfo({
        conversationId: conversation._id,
        userId: senderId,
      });
      const conversationInfoToRecipient = await getConversationInfo({
        conversationId: conversation._id,
        userId: recipientId,
      });

      await User.updateOne(
        {
          _id: ObjectId(recipientId),
        },
        {
          hasNewMsg: true,
        }
      );

      await sendToSpecificUser({
        recipientId,
        io,
        path: Route.MESSAGE + MESSAGE_PATH.GET_MESSAGE,
        payload: {
          msgs: newMessages,
          conversationInfo: conversationInfoToRecipient,
        },
      });

      cb?.({
        status: "success",
        data: {
          msgs: newMessages,
          conversationInfo: conversationInfo,
        },
      });
    } catch (error) {
      logger.error({ err: error }, "sendMessage failed");
      cb?.({ status: "error", data: [] });
    }
  }

  static async getConversations(payload: any, cb: Function, socket: Socket) {
    try {
      const authUserId = (socket as any)?.user?.userId;
      if (!authUserId) {
        cb?.({ status: "error", message: "Unauthorized", data: [] });
        return;
      }

      // Rate limiting check
      const rateCheck = messageQueryLimiter.check(authUserId);
      if (!rateCheck.allowed) {
        cb?.({ status: "error", message: "Too many requests", code: "RATE_LIMIT_EXCEEDED", data: [] });
        return;
      }

      const cleanPayload = sanitizeNoSqlPayload(payload);
      const validation = getConversationsSchema.safeParse(cleanPayload);
      if (!validation.success) {
        cb?.({ status: "error", message: "Invalid query parameters", data: [] });
        return;
      }

      const page = validation.data.page ?? 1;
      const limit = validation.data.limit ?? 15;
      const searchValue = sanitizeText(validation.data.searchValue);
      const skip = (page - 1) * limit;

      const agg: any[] = [
        {
          $match: {
            participants: ObjectId(authUserId),
          },
        },
        {
          $sort: {
            updatedAt: -1,
          },
        },
        {
          $project: {
            otherParticipant: {
              $arrayElemAt: [
                {
                  $filter: {
                    input: "$participants",
                    cond: { $ne: ["$$this", ObjectId(authUserId)] },
                  },
                },
                0,
              ],
            },
            theme: 1,
            emoji: 1,
            lastMsgId: 1,
          },
        },
        {
          $skip: skip,
        },
        {
          $limit: limit,
        },
        {
          $lookup: {
            from: "users",
            localField: "otherParticipant",
            foreignField: "_id",
            pipeline: [
              {
                $project: {
                  _id: 1,
                  username: 1,
                  avatar: 1,
                },
              },
            ],
            as: "participant",
          },
        },
        {
          $match: {
            "participant.username": {
              $regex: searchValue || "",
              $options: "i",
            },
          },
        },
        {
          $unwind: "$participant",
        },
        {
          $lookup: {
            from: "messages",
            localField: "lastMsgId",
            foreignField: "_id",
            as: "lastMsg",
          },
        },
      ];

      const conversations = await Conversation.aggregate(agg);
      const result = conversations.map((conversation) => {
        delete conversation.otherParticipant;
        delete conversation.lastMsgId;
        if (conversation?.lastMsg) {
          conversation.lastMsg = conversation.lastMsg[0];
        }
        return conversation;
      });

      cb?.({ status: "success", data: result });
    } catch (error) {
      logger.error({ err: error }, "getConversations failed");
      cb?.({ status: "error", data: [] });
    }
  }

  static async getMessages(payload: any, cb: Function, socket: Socket) {
    try {
      const authUserId = (socket as any)?.user?.userId;
      if (!authUserId) {
        cb?.({ status: "error", message: "Unauthorized", data: [] });
        return;
      }

      // Rate limiting check
      const rateCheck = messageQueryLimiter.check(authUserId);
      if (!rateCheck.allowed) {
        cb?.({ status: "error", message: "Too many requests", code: "RATE_LIMIT_EXCEEDED", data: [] });
        return;
      }

      const cleanPayload = sanitizeNoSqlPayload(payload);
      const validation = getMessagesSchema.safeParse(cleanPayload);
      if (!validation.success) {
        cb?.({ status: "error", message: "Invalid parameters", data: [] });
        return;
      }

      const { conversationId } = validation.data;
      const page = validation.data.page ?? 1;
      const limit = validation.data.limit ?? 30;

      const conversation = await Conversation.findOne({
        _id: ObjectId(conversationId),
        participants: ObjectId(authUserId),
      });

      if (!conversation) {
        cb?.({ status: "error", message: "Conversation not found or access denied", data: [] });
        return;
      }

      const skip = (page - 1) * limit;

      const msgs = await Message.find({
        conversationId: ObjectId(conversationId),
      })
        .sort({
          createdAt: -1,
        })
        .skip(skip)
        .limit(limit)
        .populate({
          path: "file",
        })
        .populate({
          path: "links",
        })
        .populate({
          path: "respondTo",
        });

      const result = msgs.sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      cb?.({ status: "success", data: result });
    } catch (error) {
      logger.error({ err: error }, "getMessages failed");
      cb?.({ status: "error", data: [] });
    }
  }

  static async getMsgsToSearchMsg(payload: any, cb: Function, socket: Socket) {
    try {
      const authUserId = (socket as any)?.user?.userId;
      if (!authUserId) {
        cb?.({ status: "error", data: [], page: 1 });
        return;
      }

      const rateCheck = messageQueryLimiter.check(authUserId);
      if (!rateCheck.allowed) {
        cb?.({ status: "error", message: "Too many requests", code: "RATE_LIMIT_EXCEEDED", data: [], page: 1 });
        return;
      }

      const cleanPayload = sanitizeNoSqlPayload(payload);
      const validation = getMsgsToSearchMsgSchema.safeParse(cleanPayload);
      if (!validation.success) {
        cb?.({ status: "error", data: [], page: 1 });
        return;
      }

      const { conversationId, searchMsgId } = validation.data;
      const limit = validation.data.limit ?? 30;
      const currentPage = validation.data.currentPage ?? 1;

      const conversation = await Conversation.findOne({
        _id: ObjectId(conversationId),
        participants: ObjectId(authUserId),
      });

      if (!conversation) {
        cb?.({ status: "error", data: [], page: 1 });
        return;
      }

      const targetMsg = await Message.findOne({
        _id: ObjectId(searchMsgId),
        conversationId: ObjectId(conversationId),
      });

      if (!targetMsg) {
        cb?.({ status: "error", data: [], page: 1 });
        return;
      }

      const newerCount = await Message.countDocuments({
        conversationId: ObjectId(conversationId),
        createdAt: { $gte: targetMsg.createdAt },
      });

      const page = Math.ceil(newerCount / limit);
      if (page <= currentPage) {
        cb?.({ status: "success", data: [] });
        return;
      }

      const skip = currentPage * limit;
      const newLimit = (page - currentPage) * limit;

      const msgs = await Message.find({
        conversationId: ObjectId(conversationId),
      })
        .sort({
          createdAt: -1,
        })
        .skip(skip)
        .limit(newLimit)
        .populate({
          path: "file",
        })
        .populate({
          path: "links",
        });

      const result = msgs.sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      cb?.({ status: "success", data: result, page: page });
    } catch (err) {
      logger.error({ err }, "getMsgsToSearchMsg failed");
      cb?.({ status: "error", data: [], page: 1 });
    }
  }

  static async reactMsg(payload: any, cb: Function, socket: Socket, io: Server) {
    try {
      const authUserId = (socket as any)?.user?.userId;
      if (!authUserId) {
        cb?.({ status: "error", message: "Unauthorized", data: null });
        return;
      }

      // Rate limit check
      const rateCheck = messageActionLimiter.check(authUserId);
      if (!rateCheck.allowed) {
        cb?.({ status: "error", message: "Too many actions", code: "RATE_LIMIT_EXCEEDED", data: null });
        return;
      }

      const cleanPayload = sanitizeNoSqlPayload(payload);
      const validation = reactMsgSchema.safeParse(cleanPayload);
      if (!validation.success) {
        cb?.({ status: "error", message: "Invalid react parameters", data: null });
        return;
      }

      const { msgId } = validation.data;
      const react = sanitizeText(validation.data.react);

      const msgInfo = await Message.findOne({
        _id: ObjectId(msgId),
      });

      if (!msgInfo) {
        cb?.({ status: "error", message: "Message not found", data: null });
        return;
      }

      const conversation = await Conversation.findOne({
        _id: msgInfo.conversationId,
        participants: ObjectId(authUserId),
      });

      if (!conversation) {
        cb?.({ status: "error", message: "Access denied", data: null });
        return;
      }

      const msgReact = msgInfo.reacts || [];
      const validUserReact = msgReact.find(
        (userReact: any) => userReact?.userId === authUserId
      );

      let result: any = null;
      if (validUserReact) {
        let newReacts: any[] = [];
        if (validUserReact?.react === react) {
          newReacts = msgReact.filter((r: any) => r?.userId !== authUserId);
        } else {
          newReacts = msgReact.map((reactInfo: any) => {
            if (reactInfo?.userId === authUserId) {
              return {
                userId: authUserId,
                react: react,
              };
            }
            return reactInfo;
          });
        }
        await Message.updateOne(
          {
            _id: ObjectId(msgId),
          },
          {
            $set: {
              reacts: newReacts,
            },
          },
          { timestamps: false }
        );
      } else {
        const newReact = {
          userId: authUserId,
          react: react,
        };
        await Message.updateOne(
          {
            _id: ObjectId(msgId),
          },
          {
            $push: {
              reacts: newReact,
            },
          },
          { timestamps: false }
        );
      }

      result = await Message.findOne({
        _id: ObjectId(msgId),
      })
        .populate({
          path: "file",
        })
        .populate({
          path: "links",
        })
        .populate({
          path: "respondTo",
        });

      const otherParticipants = (conversation.participants || []).filter(
        (p: any) => destructObjectId(p) !== authUserId
      );

      for (const p of otherParticipants) {
        await sendToSpecificUser({
          recipientId: destructObjectId(p),
          io,
          path: Route.MESSAGE + MESSAGE_PATH.UPDATE_MSG,
          payload: result,
        });
      }

      cb?.({ status: "success", data: result });
    } catch (err) {
      logger.error({ err }, "reactMsg failed");
      cb?.({ status: "error", data: null });
    }
  }

  static async changeSettingConversation(
    payload: any,
    cb: Function,
    socket: Socket,
    io: Server
  ) {
    try {
      const authUserId = (socket as any)?.user?.userId;
      if (!authUserId) {
        cb?.({ status: "error", message: "Unauthorized", data: null });
        return;
      }

      // Rate limit check
      const rateCheck = messageActionLimiter.check(authUserId);
      if (!rateCheck.allowed) {
        cb?.({ status: "error", message: "Too many actions", code: "RATE_LIMIT_EXCEEDED", data: null });
        return;
      }

      const cleanPayload = sanitizeNoSqlPayload(payload);
      const validation = changeSettingConversationSchema.safeParse(cleanPayload);
      if (!validation.success) {
        cb?.({ status: "error", message: "Invalid setting parameters", data: null });
        return;
      }

      const { key, value, conversationId } = validation.data;
      const changeSettingContent = sanitizeText(validation.data.changeSettingContent);

      const conversation = await Conversation.findOne({
        _id: ObjectId(conversationId),
        participants: ObjectId(authUserId),
      });

      if (!conversation) {
        cb?.({ status: "error", message: "Conversation not found or access denied", data: null });
        return;
      }

      const msgId = ObjectId();
      const settingMsg = new Message({
        _id: msgId,
        conversationId: ObjectId(conversationId),
        content: changeSettingContent,
        sender: ObjectId(authUserId),
        type: SETTING,
      });

      const result = await settingMsg.save();
      conversation[key] = value;
      conversation.lastMsgId = msgId;
      await conversation.save();

      const conversationInfo = await getConversationInfo({
        conversationId: conversation._id,
        userId: authUserId,
      });

      const otherParticipants = (conversation.participants || []).filter(
        (p: any) => destructObjectId(p) !== authUserId
      );

      for (const p of otherParticipants) {
        const recipientId = destructObjectId(p);
        const conversationInfoToRecipient = await getConversationInfo({
          conversationId: conversation._id,
          userId: recipientId,
        });

        await sendToSpecificUser({
          recipientId,
          io,
          path: Route.MESSAGE + MESSAGE_PATH.GET_MESSAGE,
          payload: {
            msgs: [result],
            conversationInfo: conversationInfoToRecipient,
          },
        });
      }

      cb?.({
        status: "success",
        data: {
          msgs: [result],
          conversationInfo,
        },
      });
    } catch (err) {
      logger.error({ err }, "changeSettingConversation failed");
      cb?.({ status: "error", data: null });
    }
  }

  static async retrieveMsg(payload: any, cb: Function, socket: Socket, io: Server) {
    try {
      const authUserId = (socket as any)?.user?.userId;
      if (!authUserId) {
        cb?.({ status: "error", message: "Unauthorized", data: null });
        return;
      }

      // Rate limit check
      const rateCheck = messageActionLimiter.check(authUserId);
      if (!rateCheck.allowed) {
        cb?.({ status: "error", message: "Too many actions", code: "RATE_LIMIT_EXCEEDED", data: null });
        return;
      }

      const cleanPayload = sanitizeNoSqlPayload(payload);
      const validation = retrieveMsgSchema.safeParse(cleanPayload);
      if (!validation.success) {
        cb?.({ status: "error", message: "Invalid message ID", data: null });
        return;
      }

      const { msgId } = validation.data;

      const msgInfo = await Message.findOne({
        _id: ObjectId(msgId),
      });

      if (!msgInfo || destructObjectId(msgInfo.sender) !== authUserId) {
        cb?.({ status: "error", message: "Only sender can retrieve message", data: null });
        return;
      }

      const conversation = await Conversation.findOne({
        _id: msgInfo.conversationId,
        participants: ObjectId(authUserId),
      });

      if (!conversation) {
        cb?.({ status: "error", data: null });
        return;
      }

      await Message.updateOne(
        {
          _id: ObjectId(msgId),
        },
        {
          isRetrieve: true,
        },
        { timestamps: false }
      );

      const result = await Message.findOne({
        _id: ObjectId(msgId),
      });

      const otherParticipants = (conversation.participants || []).filter(
        (p: any) => destructObjectId(p) !== authUserId
      );

      for (const p of otherParticipants) {
        await sendToSpecificUser({
          recipientId: destructObjectId(p),
          io,
          path: Route.MESSAGE + MESSAGE_PATH.UPDATE_MSG,
          payload: result,
        });
      }

      cb?.({
        status: "success",
        data: result,
      });
    } catch (err) {
      logger.error({ err }, "retrieveMsg failed");
      cb?.({ status: "error", data: null });
    }
  }

  static async updateLastSeen(payload: any, cb: Function, socket: Socket, io: Server) {
    try {
      const authUserId = (socket as any)?.user?.userId;
      if (!authUserId) {
        cb?.({ status: "error", message: "Unauthorized", data: null });
        return;
      }

      // Rate limit check
      const rateCheck = messageActionLimiter.check(authUserId);
      if (!rateCheck.allowed) {
        cb?.({ status: "error", message: "Too many actions", code: "RATE_LIMIT_EXCEEDED", data: null });
        return;
      }

      const cleanPayload = sanitizeNoSqlPayload(payload);
      const validation = updateLastSeenSchema.safeParse(cleanPayload);
      if (!validation.success) {
        cb?.({ status: "error", message: "Invalid payload", data: null });
        return;
      }

      const { lastMsg } = validation.data;
      const conversationId = ObjectId(lastMsg.conversationId);
      const conversation = await Conversation.findOne({
        _id: conversationId,
        participants: ObjectId(authUserId),
      });

      if (!conversation) {
        cb?.({ status: "error", data: null });
        return;
      }

      await Message.updateMany(
        {
          conversationId: conversationId,
          usersSeen: {
            $nin: [ObjectId(authUserId)],
          },
          createdAt: {
            $lte: lastMsg.createdAt,
          },
        },
        {
          $push: {
            usersSeen: ObjectId(authUserId),
          },
        }
      );

      const lastMsgUpdated = await Message.findOne({
        _id: ObjectId(lastMsg._id),
      })
        .populate({
          path: "file",
        })
        .populate({
          path: "links",
        })
        .populate({
          path: "respondTo",
        });

      const otherParticipants = (conversation.participants || []).filter(
        (p: any) => destructObjectId(p) !== authUserId
      );

      for (const p of otherParticipants) {
        await sendToSpecificUser({
          recipientId: destructObjectId(p),
          io,
          path: Route.MESSAGE + MESSAGE_PATH.UPDATE_MSG,
          payload: lastMsgUpdated,
        });
      }

      cb?.({ status: "success", data: lastMsgUpdated });
    } catch (err) {
      logger.error({ err }, "updateLastSeen failed");
      cb?.({ status: "error", data: null });
    }
  }

  static async sendNext(payload: any, cb: Function, socket: Socket, io: Server) {
    try {
      const authUserId = (socket as any)?.user?.userId;
      if (!authUserId) {
        cb?.({ status: "error", message: "Unauthorized", data: null });
        return;
      }

      // Rate limit check
      const rateCheck = messageSendLimiter.check(authUserId);
      if (!rateCheck.allowed) {
        cb?.({ status: "error", message: "Too many messages forwarded. Please slow down.", code: "RATE_LIMIT_EXCEEDED", data: null });
        return;
      }

      const cleanPayload = sanitizeNoSqlPayload(payload);
      const validation = sendNextSchema.safeParse(cleanPayload);
      if (!validation.success) {
        cb?.({ status: "error", message: "Invalid forward payload", data: null });
        return;
      }

      const { msgInfo, conversationsInfo } = validation.data;

      // FR-4 / AD-2 (revised): KHÔNG tin `msgInfo.media` do client gửi. `msgInfo._id` chính là
      // `_id` của message GỐC đang forward (xác nhận qua `parentMsg: msgInfo._id` bên dưới), nên
      // tra thẳng DB và dùng media đã lưu — vừa chặn client inject media tuỳ ý, vừa không reject
      // media cũ (có từ trước epic này, không theo convention public_id mới).
      if (!msgInfo?._id || !mongoose.isValidObjectId(msgInfo._id)) {
        cb?.({ status: "error", message: "Invalid forward payload", data: null });
        return;
      }

      const originalMsg = await Message.findOne({ _id: ObjectId(msgInfo._id) });
      if (!originalMsg) {
        cb?.({ status: "error", message: "Original message not found", data: null });
        return;
      }

      // Fix IDOR (SEC-1/AD2-1): `_id` tồn tại là chưa đủ — client có thể gửi `_id` của message
      // thuộc conversation họ không tham gia để copy media riêng tư của người khác. Bắt buộc
      // kiểm tra quyền sở hữu, reject TOÀN BỘ batch nếu không phải participant.
      const originalConv = await Conversation.findOne({
        _id: ObjectId(originalMsg.conversationId),
        participants: ObjectId(authUserId),
      });
      if (!originalConv) {
        logger.warn(
          { socketId: socket?.id, authUserId, msgId: String(msgInfo._id) },
          "sendNext rejected: user is not a participant of the original conversation"
        );
        cb?.({ status: "error", message: "Forward not allowed", data: null });
        return;
      }

      const listMsg = conversationsInfo.map((ele: any) => {
        const newMsgInfo = {
          ...msgInfo,
          media: originalMsg.media,
          _id: ObjectId(),
          sender: ObjectId(authUserId),
          usersSeen: [],
          reacts: [],
          conversationId: ele._id,
          parentMsg: msgInfo._id,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        return newMsgInfo;
      });

      await Message.insertMany(listMsg, { ordered: false });

      for (let i = 0; i < conversationsInfo.length; i++) {
        const recipientId = conversationsInfo[i].recipientId;
        await Conversation.updateOne(
          {
            _id: conversationsInfo[i]._id,
            participants: ObjectId(authUserId),
          },
          {
            $set: {
              lastMsgId: listMsg[i]._id,
            },
          }
        );
        await User.updateOne(
          {
            _id: ObjectId(recipientId),
          },
          {
            hasNewMsg: true,
          }
        );
      }

      const listConversationInfo: any[] = [];
      for (let index = 0; index < listMsg.length; index++) {
        const msg = listMsg[index];
        const recipientId = conversationsInfo[index].recipientId;
        const conversationInfoToRecipient = await getConversationInfo({
          conversationId: msg.conversationId,
          userId: recipientId,
        });
        const convInfo = await getConversationInfo({
          conversationId: msg.conversationId,
          userId: authUserId,
        });
        listConversationInfo[index] = convInfo;

        await sendToSpecificUser({
          recipientId,
          io,
          path: Route.MESSAGE + MESSAGE_PATH.GET_MESSAGE,
          payload: {
            msgs: [msg],
            conversationInfo: conversationInfoToRecipient,
          },
        });
      }

      cb?.({
        status: "success",
        data: {
          msgs: listMsg,
          listConversationInfo: listConversationInfo,
        },
      });
    } catch (err) {
      logger.error({ err }, "sendNext failed");
      cb?.({ status: "error", data: null });
    }
  }
}
