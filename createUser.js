const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
require("dotenv").config({ quiet: true });
const db = require("./db.js");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const ask = (question) =>
  new Promise((resolve) => {
    rl.question(question, resolve);
  });

const isLikelyUrl = (value) => /^https?:\/\//i.test(value);

const copyAvatarToUploads = (avatarPathInput) => {
  const candidate = path.isAbsolute(avatarPathInput)
    ? avatarPathInput
    : path.resolve(process.cwd(), avatarPathInput);

  if (!fs.existsSync(candidate)) {
    throw new Error(`头像文件不存在: ${candidate}`);
  }
  const stat = fs.statSync(candidate);
  if (!stat.isFile()) {
    throw new Error(`头像路径不是文件: ${candidate}`);
  }

  const uploadsDir = path.join(__dirname, "uploads", "avatars");
  fs.mkdirSync(uploadsDir, { recursive: true });

  const ext = path.extname(candidate);
  const base = path.basename(candidate, ext);
  const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
  const filename = `${base}-${uniqueSuffix}${ext}`;

  fs.copyFileSync(candidate, path.join(uploadsDir, filename));
  return `/uploads/avatars/${filename}`;
};

(async () => {
  try {
    const username = (await ask("请输入管理员用户名: ")).trim();
    const password = await ask("请输入管理员密码: ");
    const avatarInputRaw = await ask("请输入头像文件路径或URL（可留空）: ");
    const avatarInput = avatarInputRaw.trim();

    if (!username || !password) {
      throw new Error("用户名和密码不能为空！");
    }

    const { rows: avatarColumnRows } = await db.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'avatar_url' LIMIT 1"
    );
    const hasAvatarUrlColumn = avatarColumnRows.length > 0;

    let avatarUrl = null;
    if (avatarInput) {
      if (!hasAvatarUrlColumn) {
        console.warn(
          "⚠️  检测到你输入了头像，但数据库 users 表没有 avatar_url 字段；已忽略头像。"
        );
        console.warn(
          "    可执行: ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;"
        );
      } else if (isLikelyUrl(avatarInput) || avatarInput.startsWith("/uploads/")) {
        avatarUrl = avatarInput;
      } else {
        avatarUrl = copyAvatarToUploads(avatarInput);
      }
    }

    // 哈希密码，10 是 salt 的轮次，越高越安全但越慢
    const hashedPassword = await bcrypt.hash(password, 10);

    const query = hasAvatarUrlColumn
      ? "INSERT INTO users (username, password_hash, avatar_url) VALUES ($1, $2, $3) RETURNING id, username, avatar_url"
      : "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username";
    const params = hasAvatarUrlColumn
      ? [username, hashedPassword, avatarUrl]
      : [username, hashedPassword];

    const { rows } = await db.query(query, params);

    console.log("✅ 管理员用户创建成功:");
    console.log(rows[0]);
  } catch (error) {
    console.error("❌ 创建用户时出错:", error.message);
  } finally {
    db.end();
    rl.close();
  }
})();
