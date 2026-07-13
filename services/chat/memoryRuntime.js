const { memoryV2Config } = require("../../config");
const { logger } = require("../../logger");
const { createDefaultMemoryRuntime, createDefaultProjectionDrain } = require("../../modules/memory");
const { createChatRagProjectionAdapter, createQueryTimeRecallProjectionAdapter } = require("./rag/projectionAdapters");

const projectionDrains = memoryV2Config.enabled ? {
  rag: createDefaultProjectionDrain("rag", createChatRagProjectionAdapter()),
  recall: createDefaultProjectionDrain("recall", createQueryTimeRecallProjectionAdapter()),
} : {};

module.exports = createDefaultMemoryRuntime({
  config: memoryV2Config,
  projectionDrains,
  onBackgroundError: (error) => logger.error("memory_v2_background_failed", { error }),
});
