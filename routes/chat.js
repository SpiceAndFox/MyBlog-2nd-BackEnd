// routes/chat.js
const express = require("express");
const router = express.Router();
const authMiddleware = require("@middleware/authMiddleware");
const chatController = require("@controllers/chatController");
const uploadChatPresetAvatar = require("@middleware/uploadChatPresetAvatar");

router.use(authMiddleware);

router.get("/meta", chatController.getMeta);
router.get("/privacy-operations/:operationId", chatController.getPrivacyOperation);

router.get("/presets", chatController.listPresets);
router.get("/presets/trash", chatController.listTrashedPresets);
router.post("/presets", chatController.createPreset);
router.patch("/presets/:presetId", chatController.updatePreset);
router.post("/presets/:presetId/memory/rebuild", chatController.rebuildPresetMemory);
router.delete("/presets/:presetId", chatController.deletePreset);
router.patch("/presets/:presetId/restore", chatController.restorePreset);
router.delete("/presets/:presetId/permanent", chatController.deletePresetPermanently);
router.post("/presets/:presetId/avatar", uploadChatPresetAvatar.single("avatar"), chatController.uploadPresetAvatar);

router.get("/sessions", chatController.listSessions);
router.get("/sessions/trash", chatController.listTrashedSessions);
router.post("/sessions", chatController.createSession);
router.delete("/sessions/:sessionId", chatController.deleteSession);
router.patch("/sessions/:sessionId/restore", chatController.restoreSession);
router.delete("/sessions/:sessionId/permanent", chatController.deleteSessionPermanently);
router.get("/sessions/:sessionId/messages", chatController.listMessages);
router.patch("/sessions/:sessionId/messages/:messageId", chatController.editMessage);
router.post("/sessions/:sessionId/messages", chatController.sendMessage);

module.exports = router;
