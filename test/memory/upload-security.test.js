const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const express = require("express");

const avatarUpload = require("../../middleware/uploadChatPresetAvatar");
const coverUpload = require("../../middleware/uploadArticleCover");
const contentUpload = require("../../middleware/uploadArticleContentImage");

test("Multer is fixed and every reachable upload has explicit structural limits", () => {
  assert.equal(require("multer/package.json").version, "2.2.0");
  assert.deepEqual(
    [avatarUpload, coverUpload, contentUpload].map((upload) => ({
      files: upload.limits.files,
      fields: upload.limits.fields,
      parts: upload.limits.parts,
      fieldNestingDepth: upload.limits.fieldNestingDepth,
    })),
    [
      { files: 1, fields: 0, parts: 1, fieldNestingDepth: 0 },
      { files: 1, fields: 20, parts: 21, fieldNestingDepth: 2 },
      { files: 1, fields: 0, parts: 1, fieldNestingDepth: 0 },
    ],
  );
});

test("malformed avatar multipart removes the partially written disk file", async () => {
  const avatarDir = path.join(__dirname, "..", "..", "uploads", "assistant_avatars");
  const before = new Set(await fs.readdir(avatarDir));
  const app = express();
  app.post("/", avatarUpload.single("avatar"), (_req, res) => res.status(204).end());
  app.use((_error, _req, res, _next) => res.status(400).end());
  const server = await new Promise((resolve) => {
    const value = app.listen(0, "127.0.0.1", () => resolve(value));
  });
  const boundary = `stage2-${Date.now()}`;
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: `--${boundary}\r\nContent-Disposition: form-data; name="avatar"; filename="canary.png"\r\nContent-Type: image/png\r\n\r\ncanary-without-closing-boundary`,
    });
    assert.equal(response.status, 400);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = await fs.readdir(avatarDir);
    const leaked = after.filter((name) => !before.has(name));
    for (const name of leaked) await fs.rm(path.join(avatarDir, name), { force: true });
    assert.deepEqual(leaked, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
