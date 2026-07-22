const express = require("express");
const diaryController = require("@controllers/diaryController");

function createDiariesRouter({ authMiddleware } = {}) {
  if (typeof authMiddleware !== "function") throw new Error("Auth middleware is required");

  const router = express.Router();
  router.get("/", authMiddleware, diaryController.getCurrentUserDiaries);
  router.post("/", authMiddleware, diaryController.createDiary);
  router.get("/:id", authMiddleware, diaryController.getCurrentUserDiaryById);

  return router;
}

module.exports = { createDiariesRouter };
