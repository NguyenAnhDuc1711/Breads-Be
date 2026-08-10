import cloudinary from "cloudinary";
import express from "express";
import fs from "fs";
import { UTIL_PATH } from "../../Breads-Shared/APIConfig.js";
import { fileTypes } from "../../Breads-Shared/Constants/index.js";
import { OK } from "../../core/success.response.js";
import logger from "../../core/logger.js";
import asyncHandler from "../../helpers/asyncHandler.js";
import { ObjectId } from "../../utils/index.js";
import { sendForgotPWMail } from "../controllers/util.controller.js";
import protectRoute from "../middlewares/protectRoute.js";
import { getAllFiles, upload } from "../middlewares/upload.js";
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

router.post(
  UTIL_PATH.UPLOAD,
  protectRoute,
  upload.array("files"),
  validate(uploadSchema),
  asyncHandler(async (req, res) => {
    const userId = req.query.userId;
    const filesName = req.body.filesName.split(",");
    const filesInfo = JSON.parse(JSON.stringify(req.files));
    const dir = `./uploads/${userId}`;
    const filesPath = await getAllFiles(dir);
    const urls = [];
    let i = 0;
    for (let filePath of filesPath) {
      await cloudinary.v2.uploader.upload(
        filePath,
        { resource_type: "raw" },
        function (error, result) {
          if (error) {
            logger.error({ err: error }, "cloudinary upload failed");
          }
          if (result?.secure_url) {
            urls[i] = result.secure_url;
            i++;
          }
        }
      );
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
router.post(
  UTIL_PATH.SEND_FORGOT_PW_MAIL,
  validate(sendForgotPWMailSchema),
  sendForgotPWMail
);

export default router;
