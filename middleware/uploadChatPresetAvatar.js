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

function createChatPresetAvatarUpload({ uploadsRoot = defaultUploadsRoot } = {}) {
  const avatarDir = path.join(uploadsRoot, "assistant_avatars");
  const storage = multer.diskStorage({
    destination(req, file, cb) {
      fs.mkdir(avatarDir, { recursive: true }, (error) => cb(error, avatarDir));
    },
    filename(req, file, cb) {
      const ext = path.extname(file.originalname).toLowerCase().slice(0, 10);
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, `avatar-${uniqueSuffix}${ext}`);
    },
  });

  return multer({
    storage,
    fileFilter,
    limits: {
      fileSize: 10 * 1024 * 1024, // 10MB
      files: 1,
      fields: 0,
      fieldNestingDepth: 0,
    },
  });
}

module.exports = createChatPresetAvatarUpload();
module.exports.createChatPresetAvatarUpload = createChatPresetAvatarUpload;
