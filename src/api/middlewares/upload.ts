import fs from "fs";
import multer from "multer";
import path from "path";
import mongoose from "mongoose";
import { fileTypes } from "../../Breads-Shared/Constants/index.js";
import { BadRequestError } from "../../core/error.response.js";

let uploadFolder = "./uploads";

const uploadsDir = "./uploads";
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

export const validateUploadUserId = (req, _res, next) => {
  const userId = req.query.userId;
  if (typeof userId !== "string" || !mongoose.isValidObjectId(userId)) {
    return next(new BadRequestError("Invalid userId"));
  }
  next();
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const directory = path.join(uploadFolder, req.query.userId as string);
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }

    cb(null, directory);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});

const ALLOWED_MIME_TYPES = new Set(Object.values(fileTypes).flat());

const fileFilter: multer.Options["fileFilter"] = (req: any, file, cb) => {
  if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
    (req.rejectedFileTypes ??= []).push(file.mimetype);
    return cb(null, false);
  }
  cb(null, true);
};

export const rejectUnsupportedFileTypes = (req: any, _res, next) => {
  if (req.rejectedFileTypes?.length) {
    return next(new BadRequestError(`Unsupported file type: ${req.rejectedFileTypes[0]}`));
  }
  next();
};

export const getAllFiles = (folderPath) => {
  const relativePath = folderPath.startsWith("/")
    ? `.${folderPath}`
    : folderPath;

  return new Promise((resolve, reject) => {
    fs.readdir(relativePath, (err, files) => {
      if (err) {
        return reject(err);
      }

      const filePaths = files
        .filter((file) => fs.statSync(path.join(relativePath, file)).isFile())
        .map((file) => path.join(relativePath, file));

      resolve(filePaths);
    });
  });
};

const parsePositiveInt = (raw: string | undefined, def: number): number => {
  if (!raw) return def;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? Math.trunc(v) : def;
};

export const MAX_FILE_SIZE_BYTES = parsePositiveInt(
  process.env.UPLOAD_MAX_FILE_SIZE_BYTES,
  10 * 1024 * 1024
);
export const MAX_FILES_PER_REQUEST = parsePositiveInt(
  process.env.UPLOAD_MAX_FILES_PER_REQUEST,
  10
);

export const upload = multer({
  storage: storage,
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: MAX_FILES_PER_REQUEST,
  },
  fileFilter,
});
