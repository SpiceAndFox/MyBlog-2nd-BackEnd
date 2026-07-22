const express = require("express");
const cors = require("cors");
const path = require("path");
const { installHealthEndpoints } = require("./serverLifecycle");

function createHttpApplication({ health, requestLogger, chatRouter, auth } = {}) {
  if (!health) throw new Error("HTTP application health state is required");
  if (typeof requestLogger !== "function") throw new Error("HTTP request logger is required");
  if (typeof chatRouter !== "function") throw new Error("Chat router is required");
  if (!auth?.middleware || !auth?.controller) throw new Error("Auth runtime is required");

  // Route modules are loaded only after composition has installed config,
  // database, logging, Auth, and module runtime adapters.
  const { createAuthRouter } = require("../../routes/auth");
  const { createDiariesRouter } = require("../../routes/diaries");
  const { createAdminTagsRouter } = require("../../routes/admin/tags");
  const { createAdminArticlesRouter } = require("../../routes/admin/articles");
  const tagsRouter = require("../../routes/tags");
  const articlesRouter = require("../../routes/articles");
  const errorHandler = require("../../middleware/errorHandler");

  const authRouter = createAuthRouter({ authMiddleware: auth.middleware, authController: auth.controller });
  const diariesRouter = createDiariesRouter({ authMiddleware: auth.middleware });
  const adminTagsRouter = createAdminTagsRouter({ authMiddleware: auth.middleware });
  const adminArticlesRouter = createAdminArticlesRouter({ authMiddleware: auth.middleware });

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
