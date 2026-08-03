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

export const upload = multer({
  storage: storage,
});
