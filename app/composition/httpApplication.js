const express = require("express");
const cors = require("cors");
const path = require("path");
const { installHealthEndpoints } = require("../../services/serverLifecycle");

function createHttpApplication({ health, requestLogger, chatRouter } = {}) {
  if (!health) throw new Error("HTTP application health state is required");
  if (typeof requestLogger !== "function") throw new Error("HTTP request logger is required");
  if (typeof chatRouter !== "function") throw new Error("Chat router is required");

  // Route modules are loaded only after composition has installed config,
  // database, logging, Auth, and module runtime adapters.
  const tagsRouter = require("../../routes/tags");
  const articlesRouter = require("../../routes/articles");
  const diariesRouter = require("../../routes/diaries");
  const adminArticlesRouter = require("../../routes/admin/articles");
  const authRouter = require("../../routes/auth");
  const adminTagsRouter = require("../../routes/admin/tags");
  const errorHandler = require("../../middleware/errorHandler");

  const app = express();
  app.use(cors());
  app.use(requestLogger);
  app.use(express.json());
  installHealthEndpoints(app, health);
  app.use("/uploads", express.static(path.join(__dirname, "..", "..", "uploads")));
  app.use("/api/tags", tagsRouter);
  app.use("/api/admin/tags", adminTagsRouter);
  app.use("/api/articles", articlesRouter);
  app.use("/api/diaries", diariesRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/chat", chatRouter);
  app.use("/api/admin/articles", adminArticlesRouter);
  app.use(errorHandler);
  return app;
}

module.exports = { createHttpApplication };
