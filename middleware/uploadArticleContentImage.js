const multer = require("multer");
const path = require("path");
const fs = require("fs");

const rawDir = path.join(__dirname, "..", "uploads", "articles", "content", "raw");
fs.mkdirSync(rawDir, { recursive: true });

const storage = multer.diskStorage({
  destination: rawDir,
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, `content-${unique}${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  if (!file.mimetype.startsWith("image/")) return cb(new Error("只支持图片上传"), false);
  cb(null, true);
};

module.exports = multer({ storage, fileFilter, limits: { fileSize: 20 * 1024 * 1024 } });
