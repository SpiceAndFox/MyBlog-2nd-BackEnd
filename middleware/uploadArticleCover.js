// middleware/uploadArticleCover.js
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const defaultUploadsRoot = path.join(__dirname, "..", "uploads");

const fileFilter = (req, file, cb) => {
  if (!file.mimetype.startsWith("image/")) {
    return cb(new Error("只支持图片文件上传"), false);
  }
  cb(null, true);
};

function createArticleCoverUpload({ uploadsRoot = defaultUploadsRoot } = {}) {
  const rawDir = path.join(uploadsRoot, "raw");
  const storage = multer.diskStorage({
    destination(req, file, cb) {
      fs.mkdir(rawDir, { recursive: true }, (error) => cb(error, rawDir));
    },
    filename(req, file, cb) {
      const ext = path.extname(file.originalname).toLowerCase();
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, `cover-${uniqueSuffix}${ext}`);
    },
  });

  return multer({
    storage,
    fileFilter,
    limits: {
      fileSize: 20 * 1024 * 1024, // 20MB
      files: 1,
      fields: 20,
      parts: 21,
      fieldNestingDepth: 2,
    },
  });
}

module.exports = createArticleCoverUpload();
module.exports.createArticleCoverUpload = createArticleCoverUpload;
