import { ObjectId, destructObjectId, escapeRegex } from "../../utils/index.js";
import { genConversations, genMsgsInConversations } from "../crawl.js";
import Conversation from "../models/conversation.model.js";
import Link from "../models/link.model.js";
import Message from "../models/message.model.js";
import { getConversationInfo } from "../services/message.js";
import { BadRequestError, NotFoundError } from "../../core/error.response.js";
import { CREATED, OK } from "../../core/success.response.js";

export const getConversationByUsersId = async (req, res) => {
  const { anotherId } = req.body;
  const userId = String(req.user._id);
  if (!anotherId) {
    throw new BadRequestError("Empty payload");
  }
  const data = await Conversation.findOne({
    participants: { $all: [userId, anotherId] },
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
    new OK({
      message: "Conversation fetched successfully",
      metadata: result,
    }).send(res);
  } else {
    const newConversation = new Conversation({
      participants: [ObjectId(userId), ObjectId(anotherId)],
    });
    const result = await newConversation.save();
    new CREATED({
      message: "Conversation created successfully",
      metadata: result,
    }).send(res);
  }
};

export const getConversationById = async (req, res) => {
  const { conversationId } = req.query;
  const userId = String(req.user._id);
  if (!conversationId) {
    throw new BadRequestError("Empty conversationId");
  }
  const data = await getConversationInfo({ conversationId, userId });
  if (!!data) {
    new OK({
      message: "Conversation fetched successfully",
      metadata: data,
    }).send(res);
  } else {
    throw new NotFoundError("Invalid conversation");
  }
};

export const getConversationMedia = async (req, res) => {
  const { conversationId } = req.params;
  if (!conversationId) {
    throw new BadRequestError("Empty conversationId");
  }
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const skip = (page - 1) * limit;

  const [result] = await Message.aggregate([
    {
      $match: {
        conversationId: ObjectId(conversationId),
        "media.0": { $exists: true },
      },
    },
    { $sort: { createdAt: -1 } },
    { $unwind: "$media" },
    {
      $facet: {
        data: [
          { $skip: skip },
          { $limit: limit },
          { $replaceRoot: { newRoot: "$media" } },
        ],
        totalCount: [{ $count: "count" }],
      },
    },
  ]);
  const media = result?.data || [];
  const total = result?.totalCount?.[0]?.count || 0;
  new OK({
    message: "Conversation media fetched successfully",
    metadata: { data: media, total, page, limit },
  }).send(res);
};

export const getConversationFiles = async (req, res) => {
  const { conversationId } = req.params;
  if (!conversationId) {
    throw new BadRequestError("Empty conversationId");
  }
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const skip = (page - 1) * limit;

  const [result] = await Message.aggregate([
    {
      $match: {
        conversationId: ObjectId(conversationId),
        file: {
          $exists: true,
        },
      },
    },
    { $sort: { createdAt: -1 } },
    {
      $lookup: {
        from: "files",
        localField: "file",
        foreignField: "_id",
        as: "fileInfo",
      },
    },
    {
      $unwind: "$fileInfo",
    },
    {
      $facet: {
        data: [
          { $skip: skip },
          { $limit: limit },
          { $replaceRoot: { newRoot: "$fileInfo" } },
        ],
        totalCount: [{ $count: "count" }],
      },
    },
  ]);
  const files = result?.data || [];
  const total = result?.totalCount?.[0]?.count || 0;
  new OK({
    message: "Conversation files fetched successfully",
    metadata: { data: files, total, page, limit },
  }).send(res);
};

export const getConversationLinks = async (req, res) => {
  const { conversationId } = req.params;
  if (!conversationId) {
    throw new BadRequestError("Empty conversationId");
  }
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const skip = (page - 1) * limit;

  const [result] = await Message.aggregate([
    {
      $match: {
        conversationId: ObjectId(conversationId),
        "links.0": { $exists: true },
      },
    },
    { $sort: { createdAt: -1 } },
    { $unwind: "$links" },
    {
      $facet: {
        linkIds: [
          { $skip: skip },
          { $limit: limit },
          { $project: { _id: "$links" } },
        ],
        totalCount: [{ $count: "count" }],
      },
    },
  ]);
  const linkIds = (result?.linkIds || []).map((item) => item._id);
  const total = result?.totalCount?.[0]?.count || 0;
  const linksInfo = await Link.find({
    _id: {
      $in: linkIds,
    },
  });
  const linksById = new Map(
    linksInfo.map((link) => [String(link._id), link])
  );
  const orderedLinks = linkIds
    .map((id) => linksById.get(String(id)))
    .filter(Boolean);
  new OK({
    message: "Conversation links fetched successfully",
    metadata: { data: orderedLinks, total, page, limit },
  }).send(res);
};

interface MessageWithScore {
  content: string;
  conversationId: any;
  createdAt: Date;
  relevanceScore: number;
  [key: string]: any;
}

export const searchMsg = async (req, res) => {
  const { value, conversationId, page, limit } = req.body;
  if (!value || !conversationId) {
    throw new BadRequestError("Empty payload");
  }

  const skip = (page - 1) * limit;

  const searchTerms = value.trim().toLowerCase().split(/\s+/);

  const searchQuery = {
    conversationId: ObjectId(conversationId),
    isRetrieve: false,
    $or: [
      { content: { $regex: escapeRegex(value), $options: "i" } },
      {
        content: {
          $regex: searchTerms.map(escapeRegex).join("|"),
          $options: "i",
        },
      },
      ...searchTerms
        .filter((term) => term.length > 2)
        .map((term) => ({
          content: {
            $regex: term.split("").map(escapeRegex).join("\\s*"),
            $options: "i",
          },
        })),
    ],
  };

  const msgsFind = await Message.find(searchQuery)
    .sort({
      createdAt: -1,
    })
    .skip(skip)
    .limit(limit);

  const results: MessageWithScore[] = msgsFind.map((msg) => {
    let relevanceScore = 0;
    const content = (msg.content || "").toLowerCase();

    if (content.includes(value.toLowerCase())) {
      relevanceScore += 15;
    }

    searchTerms.forEach((term) => {
      if (term.length <= 2) return;

      if (content.includes(term)) {
        relevanceScore += 5;

        const wordBoundaryRegex = new RegExp(`\\b${term}`, "i");
        if (wordBoundaryRegex.test(content)) {
          relevanceScore += 3;
        }
      }

      if (term.length > 3) {
        const partialMatch = term.length * 0.7;
        for (let i = 0; i <= term.length - partialMatch; i++) {
          const subTerm = term.substring(i, i + Math.ceil(partialMatch));
          if (content.includes(subTerm)) {
            relevanceScore += 2;
            break;
          }
        }
      }
    });

    if (relevanceScore > 0 && content.length < 200) {
      relevanceScore += 2;
    }

    const msgObj = msg.toObject
      ? msg.toObject()
      : JSON.parse(JSON.stringify(msg));
    return {
      ...msgObj,
      relevanceScore,
    };
  });

  results.sort((a, b) => {
    if (b.relevanceScore !== a.relevanceScore) {
      return b.relevanceScore - a.relevanceScore;
    }
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  new OK({
    message: "Search messages fetched successfully",
    metadata: results,
  }).send(res);
};

export const handleFakeConversations = async (req, res) => {
  const { userId, numberConversations } = req.body;
  await genConversations(userId, numberConversations);
  new OK({
    message: "Fake conversations generated successfully",
    metadata: {},
  }).send(res);
};

export const handleFakeConversationsMsgs = async (req, res) => {
  await genMsgsInConversations();
  new OK({
    message: "Fake conversations messages generated successfully",
    metadata: {},
  }).send(res);
};
