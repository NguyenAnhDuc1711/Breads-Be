import fs from "fs";
import multer from "multer";
import path from "path";

let uploadFolder = "./uploads";

const uploadsDir = "./uploads";
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const directory = `${uploadFolder}/${req.query.userId}`;
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }

    cb(null, directory);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});

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
});
