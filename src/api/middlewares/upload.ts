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

// FR-2 (S2): `userId` phải là ObjectId hợp lệ TRƯỚC khi multer đụng vào multipart body — chặn ở
// đây (middleware thường, chạy TRƯỚC `upload.array(...)`) thay vì trong `destination` của multer,
// vì multer/busboy KHÔNG tự drain file stream khi storage callback reject bằng lỗi, làm treo
// connection giữa chừng request (xem `node_modules/multer/lib/make-middleware.js` — chỉ nhánh
// `fileFilter` reject bằng `cb(null, false)` mới tự `resume()`). Chặn trước khi multer bắt đầu đọc
// body thì không có stream nào cần drain.
export const validateUploadUserId = (req, _res, next) => {
  const userId = req.query.userId;
  if (typeof userId !== "string" || !mongoose.isValidObjectId(userId)) {
    return next(new BadRequestError("Invalid userId"));
  }
  next();
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // userId đã được `validateUploadUserId` xác thực hợp lệ trước khi tới đây.
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

// FR-2 (S2): whitelist mimetype — ảnh, video, tài liệu (word/excel/powerpoint/text/pdf). Dùng
// chung nguồn `fileTypes` (Breads-Shared/Constants) với `getFileType()` (util.route.ts) để chỉ có
// đúng 1 danh sách định nghĩa "loại file hợp lệ" trong repo.
const ALLOWED_MIME_TYPES = new Set(Object.values(fileTypes).flat());

const fileFilter: multer.Options["fileFilter"] = (req: any, file, cb) => {
  if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
    // Reject bằng `cb(null, false)`, KHÔNG `cb(err)` — nhánh này multer tự `fileStream.resume()`
    // để drain, tránh treo connection. Lỗi thật sự được ném ra ở `rejectUnsupportedFileTypes` bên
    // dưới, chạy SAU khi multer đã đọc xong toàn bộ body.
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
  // Make sure we're using a relative path
  const relativePath = folderPath.startsWith("/")
    ? `.${folderPath}`
    : folderPath;

  return new Promise((resolve, reject) => {
    fs.readdir(relativePath, (err, files) => {
      if (err) {
        return reject(err);
      }

      // Filter out directories and get only files
      const filePaths = files
        .filter((file) => fs.statSync(path.join(relativePath, file)).isFile())
        .map((file) => path.join(relativePath, file));

      resolve(filePaths);
    });
  });
};

// FR-2 (security-hardening, task 002): giới hạn dung lượng/file và số file/request để chặn DoS
// (upload file khổng lồ hoặc quá nhiều file làm đầy disk/treo server). Ngưỡng mặc định 10MB/file,
// 10 file/request — chỉnh qua env var nếu cần sau khi có dữ liệu traffic thực tế (PRD C-2), không
// cần đổi code.
const parsePositiveInt = (raw: string | undefined, def: number): number => {
  if (!raw) return def;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? Math.trunc(v) : def;
};

export const MAX_FILE_SIZE_BYTES = parsePositiveInt(
  process.env.UPLOAD_MAX_FILE_SIZE_BYTES,
  10 * 1024 * 1024 // 10MB
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
