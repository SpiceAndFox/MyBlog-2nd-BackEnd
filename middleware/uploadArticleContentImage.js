const multer = require("multer");
const path = require("path");
const fs = require("fs");

const defaultUploadsRoot = path.join(__dirname, "..", "uploads");

const fileFilter = (req, file, cb) => {
  if (!file.mimetype.startsWith("image/")) return cb(new Error("只支持图片上传"), false);
  cb(null, true);
};

function createArticleContentImageUpload({ uploadsRoot = defaultUploadsRoot } = {}) {
  const rawDir = path.join(uploadsRoot, "articles", "content", "raw");
  const storage = multer.diskStorage({
    destination(req, file, cb) {
      fs.mkdir(rawDir, { recursive: true }, (error) => cb(error, rawDir));
    },
    filename(req, file, cb) {
      const ext = path.extname(file.originalname).toLowerCase();
      const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, `content-${unique}${ext}`);
    },
  });

  return multer({
    storage,
    fileFilter,
    limits: {
      fileSize: 20 * 1024 * 1024,
      files: 1,
      fields: 0,
      fieldNestingDepth: 0,
    },
  });
}

module.exports = createArticleContentImageUpload();
module.exports.createArticleContentImageUpload = createArticleContentImageUpload;
