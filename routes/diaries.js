const express = require("express");
const router = express.Router();
const authMiddleware = require("@middleware/authMiddleware");
const diaryController = require("@controllers/diaryController");

router.get("/", authMiddleware, diaryController.getCurrentUserDiaries);
router.post("/", authMiddleware, diaryController.createDiary);
router.get("/:id", authMiddleware, diaryController.getCurrentUserDiaryById);

module.exports = router;
