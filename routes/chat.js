const express = require("express");

function createChatRouter({ authMiddleware, chatController, uploadPresetAvatar } = {}) {
  if (typeof authMiddleware !== "function") throw new Error("Chat auth middleware is required");
  if (!chatController || typeof chatController !== "object") throw new Error("Chat controller is required");
  if (!uploadPresetAvatar?.single) throw new Error("Chat avatar upload middleware is required");

  const router = express.Router();
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
  router.post("/presets/:presetId/avatar", uploadPresetAvatar.single("avatar"), chatController.uploadPresetAvatar);

  router.get("/sessions", chatController.listSessions);
  router.get("/sessions/trash", chatController.listTrashedSessions);
  router.post("/sessions", chatController.createSession);
  router.delete("/sessions/:sessionId", chatController.deleteSession);
  router.patch("/sessions/:sessionId/restore", chatController.restoreSession);
  router.delete("/sessions/:sessionId/permanent", chatController.deleteSessionPermanently);
  router.get("/sessions/:sessionId/messages", chatController.listMessages);
  router.patch("/sessions/:sessionId/messages/:messageId", chatController.editMessage);
  router.post("/sessions/:sessionId/messages", chatController.sendMessage);

  return router;
}

module.exports = { createChatRouter };
