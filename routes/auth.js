const express = require("express");

function createAuthRouter({ authMiddleware, authController } = {}) {
  if (typeof authMiddleware !== "function") throw new Error("Auth middleware is required");
  if (!authController || typeof authController !== "object") throw new Error("Auth controller is required");

  const router = express.Router();

  router.post("/login", authController.login);
  router.get("/me", authMiddleware, authController.me);
  router.patch("/me/time-zone", authMiddleware, authController.updateTimeZone);

  return router;
}

module.exports = { createAuthRouter };
