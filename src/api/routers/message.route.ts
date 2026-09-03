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
import requireConversationMember from "../middlewares/requireConversationMember.js";
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

// Bước 9 (access-control-hardening): `protectRoute` chỉ trả lời "có phải người dùng hợp lệ không",
// KHÔNG trả lời "có phải hội thoại của anh ta không". 5 route đọc dữ liệu hội thoại bên dưới trước
// đây thiếu hẳn vế thứ hai -> ai cũng đọc được tin nhắn/ảnh/file/link và tìm kiếm nội dung trong
// hội thoại riêng tư của người khác nếu biết `conversationId`. `requireConversationMember` là biên
// đó, đặt SAU `protectRoute` (cần `req.user`) và TRƯỚC `validate`/controller.
//
// `GET_CONVERSATION_BY_USERS_ID` không có `conversationId` để kiểm — nó tra hội thoại theo CẶP
// user, nên được vá ở tầng controller bằng cách dùng `req.user._id` làm 1 trong 2 participant.
router.post(
  GET_CONVERSATION_BY_USERS_ID,
  protectRoute,
  validate(getConversationByUsersIdSchema),
  asyncHandler(getConversationByUsersId)
);
router.get(
  GET_CONVERSATION_BY_ID,
  protectRoute,
  requireConversationMember("params"),
  validate(getConversationByIdQuerySchema),
  asyncHandler(getConversationById)
);
router.get(
  GET_CONVERSATION_MEDIA,
  protectRoute,
  requireConversationMember("params"),
  validate(getConversationMediaSchema),
  asyncHandler(getConversationMedia)
);
router.get(
  GET_CONVERSATION_FILES,
  protectRoute,
  requireConversationMember("params"),
  validate(getConversationFilesSchema),
  asyncHandler(getConversationFiles)
);
router.get(
  GET_CONVERSATION_LINKS,
  protectRoute,
  requireConversationMember("params"),
  validate(getConversationLinksSchema),
  asyncHandler(getConversationLinks)
);
router.post(
  SEARCH,
  protectRoute,
  requireConversationMember("body"),
  validate(searchMsgSchema),
  asyncHandler(searchMsg)
);
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
