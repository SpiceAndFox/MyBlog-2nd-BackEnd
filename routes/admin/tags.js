const express = require("express");
const tagController = require("@controllers/tagController");

function createAdminTagsRouter({ authMiddleware } = {}) {
  if (typeof authMiddleware !== "function") throw new Error("Auth middleware is required");

  const router = express.Router();
  router.use(authMiddleware);

  router.post("/", tagController.createTag);
  router.put("/:id", tagController.updateTag);
  router.delete("/:id", tagController.deleteTag);

  return router;
}

module.exports = { createAdminTagsRouter };
