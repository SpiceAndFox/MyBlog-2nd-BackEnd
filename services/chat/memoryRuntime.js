const { memoryV2Config } = require("../../config");
const { logger } = require("../../logger");
const { createDefaultMemoryRuntime, createDefaultProjectionDrain } = require("../../modules/memory");
const { createChatRagProjectionAdapter, createQueryTimeRecallProjectionAdapter } = require("./rag/projectionAdapters");
const chatRagRepo = require("./rag/repo");

const projectionDrains = memoryV2Config.enabled ? {
  rag: createDefaultProjectionDrain("rag", createChatRagProjectionAdapter()),
  recall: createDefaultProjectionDrain("recall", createQueryTimeRecallProjectionAdapter()),
} : {};

module.exports = createDefaultMemoryRuntime({
  config: memoryV2Config,
  projectionDrains,
  privacyStores: memoryV2Config.enabled ? [{
    name: "rag",
    purge: ({ userId, presetId, client }) => chatRagRepo.deleteAllChunks(userId, presetId, { client }),
    verifyPurged: async ({ userId, presetId }) => (await chatRagRepo.countChunks(userId, presetId)) === 0,
  }] : [],
  onBackgroundError: (error) => logger.error("memory_v2_background_failed", { error }),
});
