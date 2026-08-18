import cloudinary from "cloudinary";
import express from "express";
import mongoSanitize from "express-mongo-sanitize";
import hpp from "hpp";
import fs from "fs";
import { UTIL_PATH } from "../../Breads-Shared/APIConfig.js";
import { fileTypes } from "../../Breads-Shared/Constants/index.js";
import { OK } from "../../core/success.response.js";
import logger from "../../core/logger.js";
import asyncHandler from "../../helpers/asyncHandler.js";
import { ObjectId } from "../../utils/index.js";
import { sendForgotPWMail } from "../controllers/util.controller.js";
import protectRoute from "../middlewares/protectRoute.js";
import { generatePublicId } from "../services/mediaConvention.js";
import {
  rejectUnsupportedFileTypes,
  upload,
  validateUploadUserId,
} from "../middlewares/upload.js";
import { authTierLimiter } from "../middlewares/rateLimiter.js";
import { validate } from "../middlewares/validate.js";
import File from "../models/file.model.js";
import { sendForgotPWMailSchema, uploadSchema } from "../validators/util.validator.js";

const getFileType = (inputType) => {
  let fileType = "";
  const types = Object.keys(fileTypes);
  types.forEach((type) => {
    if (fileTypes[type].includes(inputType)) {
      fileType = type;
    }
  });
  return fileType;
};

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const router = express.Router();
// FR-2 (task 010): chỉ `sendForgotPWMail` đọc JSON body (chuỗi email) -> 100kb là quá đủ. Route
// UPLOAD dùng multer/multipart, `express.json` tự bỏ qua theo Content-Type nên không bị chặn.
router.use(express.json({ limit: "100kb" }));
// FR-5 (task 013): sanitize NoSQL operator + HPP.
router.use(mongoSanitize());
router.use(hpp());

router.post(
  UTIL_PATH.UPLOAD,
  protectRoute,
  validateUploadUserId,
  upload.array("files"),
  rejectUnsupportedFileTypes,
  validate(uploadSchema),
  asyncHandler(async (req: any, res) => {
    const userId = req.query.userId;
    const { entityType, recipientId } = req.body;
    const filesName = req.body.filesName.split(",");
    const filesInfo = JSON.parse(JSON.stringify(req.files));
    const dir = `./uploads/${userId}`;
    // Cùng convention `public_id` với `media` (`generatePublicId`, FR-1 epic
    // presigned-media-upload) — danh tính người upload LUÔN lấy từ `req.user`, không từ client.
    const context =
      entityType === "message"
        ? { senderId: req.user._id.toString(), recipientId }
        : { authorId: req.user._id.toString() };
    const urls = [];
    for (const file of filesInfo) {
      try {
        const result = await cloudinary.v2.uploader.upload(file.path, {
          resource_type: "raw",
          public_id: generatePublicId(entityType, context),
        });
        urls.push(result.secure_url);
      } catch (error) {
        logger.error({ err: error }, "cloudinary upload failed");
        urls.push("");
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
    // Save files to db
    const filesId = [];
    const files = filesInfo.map((file, index) => {
      let _id = ObjectId();
      filesId.push(_id);
      return {
        _id: _id,
        name: filesName[index],
        url: urls[index],
        contentType: getFileType(file.mimetype),
      };
    });
    await File.insertMany(files, { ordered: false });
    new OK({
      message: "Upload files successfully",
      metadata: filesId,
    }).send(res);
  })
);
// FR-1 (task 012): forgot-password thuộc auth-tier (5 req/phút) — chống spam gửi mail/brute-force.
router.post(
  UTIL_PATH.SEND_FORGOT_PW_MAIL,
  authTierLimiter,
  validate(sendForgotPWMailSchema),
  sendForgotPWMail
);

export default router;
