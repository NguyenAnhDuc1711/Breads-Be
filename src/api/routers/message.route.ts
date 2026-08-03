import express from "express";
import { MESSAGE_PATH } from "../../Breads-Shared/APIConfig.js";
import asyncHandler from "../../helpers/asyncHandler.js";
import {
  getConversationById,
  getConversationByUsersId,
  getConversationFiles,
  getConversationLinks,
  getConversationMedia,
  handleFakeConversations,
  handleFakeConversationsMsgs,
  searchMsg,
} from "../controllers/message.controller.js";
import protectRoute from "../middlewares/protectRoute.js";

const router = express.Router();
const {
  GET_CONVERSATION_BY_USERS_ID,
  GET_CONVERSATION_BY_ID,
  GET_CONVERSATION_MEDIA,
  GET_CONVERSATION_FILES,
  GET_CONVERSATION_LINKS,
  SEARCH,
  FAKE_CONVERSATIONS,
  FAKE_CONVERSATIONS_MSGS,
} = MESSAGE_PATH;

router.post(
  GET_CONVERSATION_BY_USERS_ID,
  protectRoute,
  asyncHandler(getConversationByUsersId)
);
router.get(
  GET_CONVERSATION_BY_ID,
  protectRoute,
  asyncHandler(getConversationById)
);
router.post(
  GET_CONVERSATION_MEDIA,
  protectRoute,
  asyncHandler(getConversationMedia)
);
router.post(
  GET_CONVERSATION_FILES,
  protectRoute,
  asyncHandler(getConversationFiles)
);
router.post(
  GET_CONVERSATION_LINKS,
  protectRoute,
  asyncHandler(getConversationLinks)
);
router.post(SEARCH, protectRoute, asyncHandler(searchMsg));
router.post(
  FAKE_CONVERSATIONS,
  protectRoute,
  asyncHandler(handleFakeConversations)
);
router.post(
  FAKE_CONVERSATIONS_MSGS,
  protectRoute,
  asyncHandler(handleFakeConversationsMsgs)
);

export default router;
