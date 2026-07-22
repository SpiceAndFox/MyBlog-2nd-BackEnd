const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const defaultUploadsRoot = path.resolve(__dirname, "..", "..", "..", "uploads");
const avatarUrlPrefix = "/uploads/assistant_avatars/";

function createAvatarStorage({ uploadsRoot = defaultUploadsRoot, imageProcessor = sharp } = {}) {
  const avatarDir = path.resolve(uploadsRoot, "assistant_avatars");

  async function deleteFile(filePath) {
    if (!filePath) return;
    try {
      await fs.promises.unlink(filePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  function resolveAvatarPath(avatarUrl) {
    const normalized = String(avatarUrl || "").trim();
    if (!normalized.startsWith(avatarUrlPrefix)) return null;
    const relative = normalized.slice(avatarUrlPrefix.length);
    if (!relative || relative !== path.basename(relative)) return null;
    const resolved = path.resolve(avatarDir, relative);
    if (path.dirname(resolved) !== avatarDir) return null;
    return resolved;
  }

  async function deleteAvatarByUrl(avatarUrl) {
    const filePath = resolveAvatarPath(avatarUrl);
    if (!filePath) return { deleted: false, reason: "unmanaged_avatar" };
    try {
      await fs.promises.unlink(filePath);
      return { deleted: true };
    } catch (error) {
      if (error?.code === "ENOENT") return { deleted: false, reason: "not_found" };
      throw error;
    }
  }

  async function avatarExists(avatarUrl) {
    const filePath = resolveAvatarPath(avatarUrl);
    if (!filePath) return false;
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  async function processUploadedAvatar(file = {}) {
    const inputPath = String(file.path || "").trim();
    const filename = String(file.filename || "").trim();
    if (!inputPath || !filename) throw new Error("Uploaded avatar path and filename are required");
    const baseName = path.parse(filename).name;
    const outputFilename = `${baseName}-compressed.webp`;
    const outputPath = path.join(path.dirname(inputPath), outputFilename);
    await imageProcessor(inputPath).rotate().resize(256, 256, { fit: "cover" }).webp({ quality: 82 }).toFile(outputPath);
    await deleteFile(inputPath);
    return { filename: outputFilename, path: outputPath, avatarUrl: `${avatarUrlPrefix}${outputFilename}` };
  }

  return {
    avatarDir,
    avatarUrlPrefix,
    resolveAvatarPath,
    deleteAvatarByUrl,
    avatarExists,
    deleteFile,
    processUploadedAvatar,
  };
}

function operationAvatarUrls(operation) {
  const payload = operation?.operation_payload ?? operation?.operationPayload ?? {};
  const urls = Array.isArray(payload?.avatarUrls) ? payload.avatarUrls : [];
  return [...new Set(urls.map((value) => String(value || "").trim()).filter(Boolean))];
}

module.exports = { createAvatarStorage, operationAvatarUrls };
