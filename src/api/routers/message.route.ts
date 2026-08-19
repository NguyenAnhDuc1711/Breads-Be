import express from "express";
import mongoSanitize from "express-mongo-sanitize";
import hpp from "hpp";
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
import { validate } from "../middlewares/validate.ts";
import {
  getConversationByUsersIdSchema,
  getConversationByIdQuerySchema,
  getConversationMediaSchema,
  getConversationFilesSchema,
  getConversationLinksSchema,
  searchMsgSchema,
  handleFakeConversationsSchema,
} from "../validators/message.validator.ts";

const router = express.Router();
// FR-2 (task 010): không route nào nhận media/base64 -> 1mb.
router.use(express.json({ limit: "1mb" }));
// FR-5 (task 013): sanitize NoSQL operator + HPP.
router.use(mongoSanitize());
router.use(hpp());
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
  validate(getConversationByUsersIdSchema),
  asyncHandler(getConversationByUsersId)
);
router.get(
  GET_CONVERSATION_BY_ID,
  protectRoute,
  validate(getConversationByIdQuerySchema),
  asyncHandler(getConversationById)
);
router.get(
  GET_CONVERSATION_MEDIA,
  protectRoute,
  validate(getConversationMediaSchema),
  asyncHandler(getConversationMedia)
);
router.get(
  GET_CONVERSATION_FILES,
  protectRoute,
  validate(getConversationFilesSchema),
  asyncHandler(getConversationFiles)
);
router.get(
  GET_CONVERSATION_LINKS,
  protectRoute,
  validate(getConversationLinksSchema),
  asyncHandler(getConversationLinks)
);
router.post(SEARCH, protectRoute, validate(searchMsgSchema), asyncHandler(searchMsg));
router.post(
  FAKE_CONVERSATIONS,
  protectRoute,
  validate(handleFakeConversationsSchema),
  asyncHandler(handleFakeConversations)
);
router.post(
  FAKE_CONVERSATIONS_MSGS,
  protectRoute,
  asyncHandler(handleFakeConversationsMsgs)
);

export default router;
