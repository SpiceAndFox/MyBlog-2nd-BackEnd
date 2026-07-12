const contracts = require("./contracts");
const domain = require("./domain");
const { loadMemoryV2Config } = require("./config/loadConfig");
const { createObserver } = require("./application/observer");
const { createNormalWritePipeline } = require("./application/normalWritePipeline");
const { createMemoryRecovery } = require("./application/recovery");
const { createMemoryHousekeeping } = require("./application/housekeeping");
const { createMemoryProviderAdapter, createMockMemoryProviderAdapter } = require("./infrastructure/providers/memoryProviderAdapter");
const { createOpenAiStructuredTransport } = require("./infrastructure/providers/openAiStructuredTransport");
const { loadProposerPrompt } = require("./prompts");

// Memory 模块之外只能从本入口访问公开能力。后续阶段按真实调用需求
// 增加 application use case，不在这里暴露 domain/infrastructure 内部文件。
module.exports = Object.freeze({
  contracts,
  domain,
  loadMemoryV2Config,
  createObserver,
  createNormalWritePipeline,
  createMemoryRecovery,
  createMemoryHousekeeping,
  createMemoryProviderAdapter,
  createMockMemoryProviderAdapter,
  createOpenAiStructuredTransport,
  loadProposerPrompt,
});
