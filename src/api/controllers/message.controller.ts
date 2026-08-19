import { ObjectId, destructObjectId } from "../../utils/index.js";
import { genConversations, genMsgsInConversations } from "../crawl.js";
import Conversation from "../models/conversation.model.js";
import Link from "../models/link.model.js";
import Message from "../models/message.model.js";
import { getConversationInfo } from "../services/message.js";
import { BadRequestError, NotFoundError } from "../../core/error.response.js";
import { CREATED, OK } from "../../core/success.response.js";

export const getConversationByUsersId = async (req, res) => {
  const { userId, anotherId } = req.body;
  if (!userId || !anotherId) {
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
  const { conversationId, userId } = req.query;
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
  const msgs = await Message.find({
    conversationId: ObjectId(conversationId),
    media: {
      $gt: {
        $size: 0,
      },
    },
  });
  const media = [];
  msgs?.forEach((msg) => {
    media.push(...msg?.media);
  });
  new OK({
    message: "Conversation media fetched successfully",
    metadata: media,
  }).send(res);
};

export const getConversationFiles = async (req, res) => {
  const { conversationId } = req.params;
  if (!conversationId) {
    throw new BadRequestError("Empty conversationId");
  }
  const msgs = await Message.aggregate([
    {
      $match: {
        conversationId: ObjectId(conversationId),
        file: {
          $exists: true,
        },
      },
    },
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
      $project: {
        fileInfo: 1,
      },
    },
  ]);
  const files = msgs?.map((msg) => msg?.fileInfo);
  new OK({
    message: "Conversation files fetched successfully",
    metadata: files,
  }).send(res);
};

export const getConversationLinks = async (req, res) => {
  const { conversationId } = req.params;
  if (!conversationId) {
    throw new BadRequestError("Empty conversationId");
  }
  const msgWithLinks = await Message.aggregate([
    {
      $match: {
        conversationId: ObjectId(conversationId),
        "links.0": { $exists: true },
      },
    },
  ]);
  const linksId = [];
  msgWithLinks?.forEach((msg) => {
    linksId.push(...msg?.links);
  });
  const linksInfo = await Link.find({
    _id: {
      $in: linksId,
    },
  });
  new OK({
    message: "Conversation links fetched successfully",
    metadata: linksInfo,
  }).send(res);
};

// Add this interface before the searchMsg function
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

  // Create search terms
  const searchTerms = value.trim().toLowerCase().split(/\s+/);
  const searchTermRegexes = searchTerms.map((term) => new RegExp(term, "i"));

  // Create an array of search criteria to improve matching
  const searchQuery = {
    conversationId: ObjectId(conversationId),
    isRetrieve: false,
    $or: [
      { content: { $regex: value, $options: "i" } }, // Exact phrase match
      { content: { $regex: searchTerms.join("|"), $options: "i" } }, // Any word match
      // Add substring matching patterns for each search term
      ...searchTerms
        .filter((term) => term.length > 2)
        .map((term) => ({
          content: { $regex: term.split("").join("\\s*"), $options: "i" }, // Flexible spacing match
        })),
    ],
  };

  // Using text score for relevance sorting when available
  const msgsFind = await Message.find(searchQuery)
    .sort({
      // Sort by creation date as a secondary sort criteria
      createdAt: -1,
    })
    .skip(skip)
    .limit(limit);

  // Add a relevance score to each result
  const results: MessageWithScore[] = msgsFind.map((msg) => {
    // Calculate a simple relevance score
    let relevanceScore = 0;
    const content = (msg.content || "").toLowerCase();

    // 1. Exact full match gets highest score
    if (content.includes(value.toLowerCase())) {
      relevanceScore += 15;
    }

    // 2. Calculate score based on number of matching terms
    searchTerms.forEach((term) => {
      if (term.length <= 2) return; // Skip very short terms

      // Full word match
      if (content.includes(term)) {
        relevanceScore += 5;

        // Additional points if it's at the beginning of a word
        const wordBoundaryRegex = new RegExp(`\\b${term}`, "i");
        if (wordBoundaryRegex.test(content)) {
          relevanceScore += 3;
        }
      }

      // Partial word match (for longer terms)
      if (term.length > 3) {
        // Check if the content contains at least 70% of the search term characters in sequence
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

    // 3. Bonus points for shorter messages that match (higher density)
    if (relevanceScore > 0 && content.length < 200) {
      relevanceScore += 2;
    }

    // Convert to plain object and add score
    const msgObj = msg.toObject
      ? msg.toObject()
      : JSON.parse(JSON.stringify(msg));
    return {
      ...msgObj,
      relevanceScore,
    };
  });

  // Sort by relevance score then by date
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
