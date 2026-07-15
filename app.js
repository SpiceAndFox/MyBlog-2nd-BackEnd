// app.js
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");
require("module-alias/register");

// 引入配置文件
dotenv.config();

const { chatConfig, memoryV2Config } = require("./config");
const { logger } = require("./logger");
const db = require("./db");
const memoryRuntime = require("./services/chat/memoryRuntime");
const scopeCoordinator = require("./services/chat/scopeCoordinator");
const {
  createHealthState,
  installHealthEndpoints,
  parseShutdownTimeout,
  createServerLifecycle,
  installProcessHandlers,
} = require("./services/serverLifecycle");
const requestLogger = require("./middleware/requestLogger");
const errorHandler = require("./middleware/errorHandler");

// 导入所有路由
const tagsRouter = require("./routes/tags");
const articlesRouter = require("./routes/articles");
const diariesRouter = require("./routes/diaries");
const adminArticlesRouter = require("./routes/admin/articles");
const authRouter = require("./routes/auth");
const adminTagsRouter = require("./routes/admin/tags");
const chatRouter = require("./routes/chat");
const { startChatTrashCleanup } = require("./services/chat/trashCleanup");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = String(process.env.HOST || "127.0.0.1").trim();
const health = createHealthState();

app.use(cors());
app.use(requestLogger);
app.use(express.json());
installHealthEndpoints(app, health);

// 开放静态资源，如 /uploads/articles/...
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// 其余路由挂载
app.use("/api/tags", tagsRouter);
app.use("/api/admin/tags", adminTagsRouter);
app.use("/api/articles", articlesRouter);
app.use("/api/diaries", diariesRouter);
app.use("/api/auth", authRouter);
app.use("/api/chat", chatRouter);

// 管理后台API (所有这里的路由都需要认证)
app.use("/api/admin/articles", adminArticlesRouter);

app.use(errorHandler);

const lifecycle = createServerLifecycle({
  app,
  memoryRuntime,
  database: db,
  logger,
  health,
  host: HOST,
  port: PORT,
  shutdownTimeoutMs: parseShutdownTimeout(process.env.SERVER_SHUTDOWN_TIMEOUT_MS),
  productionModels: {
    memoryModel: memoryV2Config.provider?.model,
    defaultChatProviderId: chatConfig.defaultProviderId,
    defaultChatModelId: chatConfig.defaultModelByProvider?.[chatConfig.defaultProviderId],
  },
  startCleanup: () => startChatTrashCleanup({
    retentionDays: chatConfig.trashRetentionDays,
    intervalMs: chatConfig.trashCleanupIntervalMs,
    batchSize: chatConfig.trashPurgeBatchSize,
  }),
  cancelInFlight: (reason) => scopeCoordinator.cancelAll(reason),
  waitForInFlight: () => scopeCoordinator.waitForIdle(),
});

if (require.main === module) {
  installProcessHandlers({ lifecycle, logger });
  void lifecycle.start().catch((error) => {
    logger.error("server_startup_failed", { port: PORT, host: HOST, error });
    process.exitCode = 1;
  });
}

module.exports = { app, lifecycle, health };
