const jwt = require("jsonwebtoken");

function createAuthMiddleware({ jwtSecret, jwtAdapter = jwt } = {}) {
  if (typeof jwtSecret !== "string" || !jwtSecret.trim()) throw new Error("Auth jwtSecret is required");
  if (typeof jwtAdapter?.verify !== "function") throw new Error("Auth JWT verifier is required");

  return function verifyToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(403).json({ error: "需要提供Token用于认证" });
    }

    const tokenParts = authHeader.split(" ");
    if (tokenParts.length !== 2 || tokenParts[0] !== "Bearer") {
      return res.status(401).json({ error: 'Token格式不正确，应为 "Bearer <token>"' });
    }

    jwtAdapter.verify(tokenParts[1], jwtSecret, (error, decoded) => {
      if (error) return res.status(401).json({ error: "Token无效或已过期" });
      req.user = decoded;
      return next();
    });
  };
}

module.exports = { createAuthMiddleware };
