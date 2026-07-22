const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const express = require("express");

const avatarUpload = require("../../middleware/uploadChatPresetAvatar");
const coverUpload = require("../../middleware/uploadArticleCover");
const contentUpload = require("../../middleware/uploadArticleContentImage");

test("every reachable upload has explicit structural limits", () => {
  // avatar 与 content 上传刻意不设 parts 聚合上限：busboy 的 parts 计数从 -1 起
  // 含收尾边界，parts:1 会把合法的单图也误判为超限。它们改由 files/fields 精确约束
  // （1 个文件、0 个文本字段），边界数仍被间接限定，安全语义不变。
  assert.deepEqual(
    [avatarUpload, coverUpload, contentUpload].map((upload) => ({
      files: upload.limits.files,
      fields: upload.limits.fields,
      parts: upload.limits.parts,
      fieldNestingDepth: upload.limits.fieldNestingDepth,
    })),
    [
      { files: 1, fields: 0, parts: undefined, fieldNestingDepth: 0 },
      { files: 1, fields: 20, parts: 21, fieldNestingDepth: 2 },
      { files: 1, fields: 0, parts: undefined, fieldNestingDepth: 0 },
    ],
  );
});

test("malformed avatar multipart removes the partially written disk file", async () => {
  const uploadsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "blog-upload-test-"));
  const avatarDir = path.join(uploadsRoot, "assistant_avatars");
  const isolatedAvatarUpload = avatarUpload.createChatPresetAvatarUpload({ uploadsRoot });
  const app = express();
  app.post("/", isolatedAvatarUpload.single("avatar"), (_req, res) => res.status(204).end());
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
    const after = await fs.readdir(avatarDir).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
    assert.deepEqual(after, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(uploadsRoot, { recursive: true, force: true });
  }
});
