const defaultBcrypt = require("bcryptjs");
const defaultJwt = require("jsonwebtoken");
const { logger: defaultLogger, withRequestContext: defaultWithRequestContext } = require("../../logger");
const { normalizeIanaTimeZone } = require("../../utils/timeZone");

function createAuthController({
  jwtSecret,
  tokenExpiresIn = "7d",
  userModel,
  bcrypt = defaultBcrypt,
  jwt = defaultJwt,
  logger = defaultLogger,
  withRequestContext = defaultWithRequestContext,
} = {}) {
  if (typeof jwtSecret !== "string" || !jwtSecret.trim()) throw new Error("Auth jwtSecret is required");
  if (!userModel) throw new Error("Auth user model is required");

  return Object.freeze({
    async me(req, res) {
      try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: "Unauthorized" });
        const user = await userModel.findById(userId);
        if (!user) return res.status(404).json({ error: "User not found" });
        return res.status(200).json({
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
        return res.status(500).json({ error: "Internal Server Error" });
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
        return res.status(200).json({
          user: {
            id: user.id,
            username: user.username,
            avatar_url: user.avatar_url || null,
            time_zone: user.time_zone,
            created_at: user.created_at,
          },
        });
      } catch (error) {
        logger.error("auth_time_zone_update_failed", withRequestContext(req, { error }));
        return res.status(500).json({ error: "Internal Server Error" });
      }
    },

    async login(req, res) {
      try {
        const { username, password } = req.body;
        if (!username || !password) {
          return res.status(400).json({ error: "用户名和密码不能为空" });
        }
        const user = await userModel.findByUsername(username);
        if (!user) return res.status(401).json({ error: "认证失败：用户名或密码错误" });
        const passwordMatches = await bcrypt.compare(password, user.password_hash);
        if (!passwordMatches) return res.status(401).json({ error: "认证失败：用户名或密码错误" });

        const token = jwt.sign(
          { id: user.id, username: user.username },
          jwtSecret,
          { expiresIn: tokenExpiresIn },
        );
        return res.status(200).json({ message: "登录成功", token });
      } catch (error) {
        logger.error("auth_login_failed", withRequestContext(req, { error }));
        return res.status(500).json({ error: "服务器内部错误" });
      }
    },
  });
}

module.exports = { createAuthController };
