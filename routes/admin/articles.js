const express = require("express");
const articleController = require("@controllers/articleController");
const uploadArticleCover = require("@middleware/uploadArticleCover");
const uploadArticleContentImage = require("@middleware/uploadArticleContentImage");

function createAdminArticlesRouter({ authMiddleware } = {}) {
  if (typeof authMiddleware !== "function") throw new Error("Auth middleware is required");

  const router = express.Router();

  router.get("/", authMiddleware, articleController.getAllArticlesAdmin);
  router.post("/", authMiddleware, uploadArticleCover.single("headerImage"), articleController.createArticle);
  router.get("/:id", authMiddleware, articleController.getArticleByIdAdmin);
  router.put("/:id", authMiddleware, uploadArticleCover.single("headerImage"), articleController.updateArticle);
  router.delete("/:id", authMiddleware, articleController.deleteArticle);
  router.post(
    "/upload-image",
    authMiddleware,
    uploadArticleContentImage.single("image"),
    articleController.uploadContentImage,
  );

  return router;
}

module.exports = { createAdminArticlesRouter };
