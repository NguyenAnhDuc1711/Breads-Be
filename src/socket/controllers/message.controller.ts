import axios from "axios";
import { Server } from "socket.io";
import Conversation from "../../api/models/conversation.model.js";
import Link from "../../api/models/link.model.js";
import Message from "../../api/models/message.model.js";
import User from "../../api/models/user.model.js";
import { getConversationInfo } from "../../api/services/message.js";
import { uploadFileFromBase64 } from "../../api/utils/index.js";
import { MESSAGE_PATH, Route } from "../../Breads-Shared/APIConfig.js";
import { Constants } from "../../Breads-Shared/Constants/index.js";
import { previewLinkKey } from "../../Breads-Shared/util/index.js";
import { ObjectId, destructObjectId } from "../../utils/index.js";
import { sendToSpecificUser } from "../services/message.js";

const { TEXT, MEDIA, FILE, SETTING } = Constants.MSG_TYPE;

export default class MessageController {
  static async sendMessage(payload: any, cb: Function, io: Server) {
    try {
      const { recipientId, senderId, message } = payload;
      let conversation = await Conversation.findOne({
        participants: { $all: [senderId, recipientId] },
      });
      const listMsgId: any = [];
      const listMsg: any = [];
      const { files, media, content, respondTo } = message;
      const numberNewMsg =
        files?.length + (media?.length > 0 ? 1 : 0) + (content ? 1 : 0);
      [...Array(numberNewMsg)].map((_) => {
        listMsgId.push(ObjectId());
      });
      if (!conversation) {
        conversation = new Conversation({
          participants: [senderId, recipientId],
          msgIds: listMsgId,
          lastMsgId: listMsgId[listMsgId.length - 1],
        });
        await conversation.save();
      } else {
        await Conversation.updateOne(
          {
            _id: ObjectId(conversation._id),
          },
          {
            $push: {
              msgIds: {
                $each: listMsgId,
              },
            },
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
          sender: senderId,
        };
        if (content?.trim() && index === 0) {
          const urlRegex = /(https?:\/\/[^\s]+)/g;
          const urls = content.match(urlRegex);
          const links: any = [];
          try {
            if (urls?.length) {
              for (let url of urls) {
                let result = null;
                const previewLen = previewLinkKey?.length;
                let index = 1;
                try {
                  do {
                    let key = previewLinkKey[index - 1];
                    try {
                      const { data } = await axios.get(
                        `https://api.linkpreview.net?key=${key}&q=${url}`
                      );
                      if (data) {
                        result = data;
                      }
                    } catch (err) {
                      index += 1;
                      console.log("End of preview link quota: ", err);
                    }
                  } while (index < previewLen && !result);
                } catch (err) {
                  console.log("getLinkPreview: ", err);
                }
                if (
                  typeof result == "object" &&
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
            console.error("getLinkPreview: ", err);
          }
          if (links?.length > 0) {
            await Link.insertMany(links, { ordered: false });
          }
          newMsg = {
            ...msgInfo,
            content: content,
            links: links?.map((_id) => _id),
            type: TEXT,
          };
          if (respondTo) {
            newMsg.respondTo = ObjectId(respondTo);
            isReplied = true;
          }
        } else if (media?.length !== 0 && !addMedia) {
          const isAddGif =
            media?.length === 1 && media[0].type === Constants.MEDIA_TYPE.GIF;
          const uploadMedia = media;
          if (!isAddGif) {
            for (let i = 0; i < media.length; i++) {
              const imgUrl = await uploadFileFromBase64({
                base64: media[i].url,
              });
              uploadMedia[i] = {
                url: imgUrl ?? media[i].url,
                type: Constants.MEDIA_TYPE.IMAGE,
              };
            }
          }
          console.log("uploadMedia: ", uploadMedia);
          newMsg = new Message({
            ...msgInfo,
            media: uploadMedia,
            type: MEDIA,
          });
          if (respondTo && !isReplied) {
            newMsg.respondTo = ObjectId(respondTo);
            isReplied = true;
          }
          addMedia = true;
        } else if (
          files?.length !== 0 &&
          (files?.length > 1
            ? currentFileIndex < files?.length - 1
            : currentFileIndex < files?.length)
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
        listMsg.push(newMsg);
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
      !!cb &&
        cb({
          status: "success",
          data: {
            msgs: newMessages,
            conversationInfo: conversationInfo,
          },
        });
    } catch (error) {
      console.error("sendMessage: ", error);
      cb({ status: "error", data: [] });
    }
  }

  static async getConversations(payload: any, cb: Function) {
    const { userId, page, limit, searchValue } = payload;
    try {
      const skip = (page - 1) * limit;
      const agg: any = [
        {
          $match: {
            participants: ObjectId(userId),
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
                    cond: { $ne: ["$$this", ObjectId(userId)] }, // Exclude userId
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
              $regex: searchValue,
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
      const result = conversations.map((conversation, index) => {
        delete conversation.otherParticipant;
        delete conversation.lastMsgId;
        if (conversation?.lastMsg) {
          conversation.lastMsg = conversation.lastMsg[0];
        }
        return conversation;
      });
      cb({ status: "success", data: result });
    } catch (error) {
      console.error("getConversations: ", error);
      cb({ status: "error", data: [] });
    }
  }
  static async getMessages(payload: any, cb: Function) {
    const { userId, conversationId, page, limit } = payload;
    const skip = (page - 1) * limit;
    try {
      if (!userId) {
        cb({ status: "error", data: [] });
        return;
      }
      const conversation = await Conversation.findOne(
        {
          _id: ObjectId(conversationId),
        },
        {
          msgIds: 1,
        }
      );
      if (!conversation) {
        cb({ status: "error", data: [] });
        return;
      }
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
      const result = msgs?.sort((a, b) => -1);
      cb({ status: "success", data: result });
    } catch (error) {
      console.error("getConversations: ", error);
      cb({ status: "error", data: [] });
    }
  }
  static async getMsgsToSearchMsg(payload: any, cb: Function) {
    try {
      const { userId, conversationId, limit, searchMsgId, currentPage } =
        payload;
      if (!userId) {
        cb({ status: "error", data: [] });
        return;
      }
      const conversation = await Conversation.findOne(
        {
          _id: ObjectId(conversationId),
        },
        {
          msgIds: 1,
        }
      );
      if (!conversation) {
        cb({ status: "error", data: [] });
        return;
      }
      const msgIds = conversation?.msgIds.map((id) => destructObjectId(id));
      const searchMsgIndex = msgIds?.findIndex((id) => id === searchMsgId);
      const page = Math.ceil((msgIds.length - searchMsgIndex) / limit);
      if (page <= currentPage) {
        cb({ status: "success", data: [] });
      } else {
        const skip = currentPage * limit;
        const newLimit = (page - currentPage) * limit;
        const msgs = await Message.find({
          _id: { $in: msgIds },
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
        const result = msgs?.sort((a, b) => -1);
        cb({ status: "success", data: result, page: page });
      }
    } catch (err) {
      console.error("getMsgsToSearchMsg: ", err);
      cb({ status: "error", data: [], page: 1 });
    }
  }
  static async reactMsg(payload: any, cb: Function, io: Server) {
    try {
      const { participantId, userId, msgId, react } = payload;
      if (!msgId || !participantId) {
        cb({ status: "error", data: [] });
        return;
      }
      const msgInfo = await Message.findOne({
        _id: ObjectId(msgId),
      });
      const msgReact = msgInfo?.reacts;
      const validUserReact = msgReact?.find(
        (userReact) => userReact?.userId === userId
      );
      let result: any = null;
      if (validUserReact) {
        let newReacts: any = [];
        if (validUserReact?.react === react) {
          newReacts = msgReact?.filter((react) => react?.userId !== userId);
        } else {
          newReacts = msgReact?.map((reactInfo) => {
            if (reactInfo?.userId === userId) {
              return {
                userId: userId,
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
          userId: userId,
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
      await sendToSpecificUser({
        recipientId: participantId,
        io,
        path: Route.MESSAGE + MESSAGE_PATH.UPDATE_MSG,
        payload: result,
      });
      !!cb && cb({ status: "success", data: result });
    } catch (err) {
      console.log("reactMsg: ", err);
      cb({ status: "error", data: null });
    }
  }
  static async changeSettingConversation(
    payload: any,
    cb: Function,
    io: Server
  ) {
    try {
      const {
        key,
        value,
        conversationId,
        userId,
        recipientId,
        changeSettingContent,
      } = payload;
      if (!conversationId || !userId) {
        cb({ status: "error", data: null });
        return;
      }
      const conversation = await Conversation.findOne({
        _id: ObjectId(conversationId),
      });
      if (!conversation) {
        cb({ status: "error", data: null });
        return;
      }
      const msgId = ObjectId();
      const settingMsg = new Message({
        _id: msgId,
        conversationId: ObjectId(conversationId),
        content: changeSettingContent,
        sender: ObjectId(userId),
        type: SETTING,
      });
      const result = await settingMsg.save();
      conversation[key] = value;
      conversation.msgIds.push(msgId);
      await conversation.save();
      const conversationInfo = await getConversationInfo({
        conversationId: conversation._id,
        userId: userId,
      });
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
      !!cb &&
        cb({
          status: "success",
          data: {
            msgs: [result],
            conversationInfo,
          },
        });
    } catch (err) {
      console.log("changeSettingConversation: ", err);
      cb({ status: "error", data: null });
    }
  }
  static async retrieveMsg(payload: any, cb: Function, io: Server) {
    try {
      const { msgId, userId, participantId } = payload;
      if (!msgId || !userId) {
        cb({ status: "error", data: null });
        return;
      }
      const msgInfo = await Message.findOne({
        _id: ObjectId(msgId),
      });
      if (!msgInfo || destructObjectId(msgInfo?.sender) !== userId) {
        cb({ status: "error", data: null });
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
      await sendToSpecificUser({
        recipientId: participantId,
        io,
        path: Route.MESSAGE + MESSAGE_PATH.UPDATE_MSG,
        payload: result,
      });
      !!cb &&
        cb({
          status: "success",
          data: result,
        });
    } catch (err) {
      console.log("retrieveMsg: ", err);
      cb({ status: "error", data: null });
    }
  }
  static async updateLastSeen(payload: any, cb: Function, io: Server) {
    try {
      const { userId, lastMsg, recipientId } = payload;
      if (!userId || !lastMsg) {
        cb({ status: "error", data: null });
        return;
      }
      const conversationId = ObjectId(lastMsg.conversationId);
      await Message.updateMany(
        {
          conversationId: conversationId,
          usersSeen: {
            $nin: [ObjectId(userId)],
          },
          createdAt: {
            $lte: lastMsg.createdAt,
          },
        },
        {
          $push: {
            usersSeen: ObjectId(userId),
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
      await sendToSpecificUser({
        recipientId,
        io,
        path: Route.MESSAGE + MESSAGE_PATH.UPDATE_MSG,
        payload: lastMsgUpdated,
      });
      !!cb && cb({ status: "success", data: lastMsgUpdated });
    } catch (err) {
      console.log("updateLastSeen: ", err);
    }
  }
  static async sendNext(payload: any, cb: Function, io: Server) {
    const { userId, msgInfo, conversationsInfo } = payload;
    const listMsg = conversationsInfo.map((ele) => {
      const newMsgInfo = {
        ...msgInfo,
        _id: ObjectId(),
        sender: userId,
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
        },
        {
          lastMsgId: listMsg[i]._id,
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

    const listConversationInfo: any = [];
    for (let index = 0; index < listMsg.length; index++) {
      const msg = listMsg[index];
      const recipientId = conversationsInfo[index].recipientId;
      const conversationInfoToRecipient = await getConversationInfo({
        conversationId: msg.conversationId,
        userId: recipientId,
      });
      const conversationInfo = await getConversationInfo({
        conversationId: msg.conversationId,
        userId: userId,
      });
      listConversationInfo[index] = conversationInfo;
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
    !!cb &&
      cb({
        status: "success",
        data: {
          msgs: listMsg,
          listConversationInfo: listConversationInfo,
        },
      });
  }
}
