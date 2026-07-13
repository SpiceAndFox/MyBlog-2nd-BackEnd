const userModel = require("@models/userModel");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { logger, withRequestContext } = require("../logger");
const { normalizeIanaTimeZone } = require("../utils/timeZone");

const authController = {
  async me(req, res) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const user = await userModel.findById(userId);
      if (!user) return res.status(404).json({ error: "User not found" });

      res.status(200).json({
        user: {
          id: user.id,
          username: user.username,
          avatar_url: user.avatar_url || null,
          time_zone: user.time_zone,
          created_at: user.created_at,
        },
      });
    } catch (error) {
      logger.error("auth_me_failed", withRequestContext(req, { error }));
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  async updateTimeZone(req, res) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });
      let timeZone;
      try { timeZone = normalizeIanaTimeZone(req.body?.time_zone); }
      catch { return res.status(400).json({ error: "time_zone must be a valid IANA time zone" }); }
      const user = await userModel.updateTimeZone(userId, timeZone);
      if (!user) return res.status(404).json({ error: "User not found" });
      return res.status(200).json({ user: { id: user.id, username: user.username, avatar_url: user.avatar_url || null, time_zone: user.time_zone, created_at: user.created_at } });
    } catch (error) {
      logger.error("auth_time_zone_update_failed", withRequestContext(req, { error }));
      return res.status(500).json({ error: "Internal Server Error" });
    }
  },

  async login(req, res) {
    try {
      const { username, password } = req.body;

      // 1. 检查请求体
      if (!username || !password) {
        return res.status(400).json({ error: "用户名和密码不能为空" });
      }

      // 2. 查找用户
      const user = await userModel.findByUsername(username);
      if (!user) {
        return res.status(401).json({ error: "认证失败：用户名或密码错误" });
      }

      // 3. 比对密码
      const isPasswordMatch = await bcrypt.compare(password, user.password_hash);
      if (!isPasswordMatch) {
        return res.status(401).json({ error: "认证失败：用户名或密码错误" });
      }

      // 4. 生成 JWT
      const payload = {
        id: user.id,
        username: user.username,
      };

      const token = jwt.sign(
        payload,
        process.env.JWT_SECRET, // 从 .env 文件读取密钥
        { expiresIn: "7d" } // Token 有效期，例如 7 天
      );

      // 5. 响应
      res.status(200).json({
        message: "登录成功",
        token: token,
      });
    } catch (error) {
      logger.error("auth_login_failed", withRequestContext(req, { error }));
      res.status(500).json({ error: "服务器内部错误" });
    }
  },
};

module.exports = authController;
