const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  createAvatarStorage,
  operationAvatarUrls,
} = require("../../modules/chat/infrastructure/avatarStorage");

test("avatar cleanup only accepts managed basenames and is idempotent", async () => {
  const uploadsRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "blog-avatar-test-"));
  const { avatarDir, resolveAvatarPath, deleteAvatarByUrl, avatarExists } = createAvatarStorage({ uploadsRoot });
  try {
    assert.equal(resolveAvatarPath("/uploads/assistant_avatars/../secret"), null);
    assert.equal(resolveAvatarPath("/uploads/articles/image.webp"), null);

    await fs.promises.mkdir(avatarDir, { recursive: true });
    const filename = `privacy-canary-${crypto.randomUUID()}.webp`;
    const filePath = path.join(avatarDir, filename);
    const url = `/uploads/assistant_avatars/${filename}`;
    await fs.promises.writeFile(filePath, "privacy-canary");
    assert.equal(await avatarExists(url), true);
    assert.deepEqual(await deleteAvatarByUrl(url), { deleted: true });
    assert.equal(await avatarExists(url), false);
    assert.deepEqual(await deleteAvatarByUrl(url), { deleted: false, reason: "not_found" });
  } finally {
    await fs.promises.rm(uploadsRoot, { recursive: true, force: true });
  }
});

test("avatar privacy store reads deduplicated targets from durable operation payload", () => {
  const operation = { operation_payload: { avatarUrls: ["/uploads/assistant_avatars/a.webp", "/uploads/assistant_avatars/a.webp"] } };
  assert.deepEqual(operationAvatarUrls(operation), ["/uploads/assistant_avatars/a.webp"]);
});
