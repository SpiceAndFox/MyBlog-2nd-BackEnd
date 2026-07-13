// routes/auth.js
const express = require("express");
const router = express.Router();
const authController = require("@controllers/authController");
const authMiddleware = require("@middleware/authMiddleware");

// POST /api/auth/login
router.post("/login", authController.login);

// GET /api/auth/me
router.get("/me", authMiddleware, authController.me);
router.patch("/me/time-zone", authMiddleware, authController.updateTimeZone);

module.exports = router;
