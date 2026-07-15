const fs = require("node:fs");
const path = require("node:path");

const uploadsRoot = path.resolve(__dirname, "..", "..", "uploads");
const avatarDir = path.resolve(uploadsRoot, "assistant_avatars");
const avatarUrlPrefix = "/uploads/assistant_avatars/";

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

function operationAvatarUrls(operation) {
  const payload = operation?.operation_payload ?? operation?.operationPayload ?? {};
  const urls = Array.isArray(payload?.avatarUrls) ? payload.avatarUrls : [];
  return [...new Set(urls.map((value) => String(value || "").trim()).filter(Boolean))];
}

module.exports = {
  avatarDir,
  avatarUrlPrefix,
  resolveAvatarPath,
  deleteAvatarByUrl,
  avatarExists,
  operationAvatarUrls,
};
