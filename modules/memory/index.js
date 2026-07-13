const contracts = require("./contracts");
const domain = require("./domain");
const { loadMemoryV2Config } = require("./config/loadConfig");
const { loadMemoryProviderConfig } = require("./config/loadProviderConfig");
const { createObserver } = require("./application/observer");
const { createNormalWritePipeline } = require("./application/normalWritePipeline");
const { createMemoryRecovery } = require("./application/recovery");
const { createMemoryHousekeeping } = require("./application/housekeeping");
const { createMemoryContextAssembly } = require("./application/contextAssembly");
const { createMemorySourceRebuild } = require("./application/sourceRebuild");
const { createMemoryStateRecovery } = require("./application/stateRecovery");
const { createProjectionDrain } = require("./application/projectionDrain");
const { createDiagnosticProjection } = require("./application/diagnosticProjection");
const { createMemoryRetention } = require("./application/retention");
const { createPrivacyHardDelete } = require("./application/privacyHardDelete");
const { createMemoryMigration } = require("./application/migration");
const { createMemoryRuntime } = require("./application/runtime");
const { createMemoryMetrics } = require("./application/metrics");
const repositories = require("./infrastructure/repositories");
const { createMemoryProviderAdapter, createMockMemoryProviderAdapter } = require("./infrastructure/providers/memoryProviderAdapter");
const { createOpenAiStructuredTransport } = require("./infrastructure/providers/openAiStructuredTransport");
const { createDeepSeekStrictToolsTransport } = require("./infrastructure/providers/deepSeekStrictToolsTransport");
const { createStructuredTransport } = require("./infrastructure/providers/structuredTransportFactory");
const { runStructuredOutputPreflight } = require("./infrastructure/providers/providerPreflight");
const { loadProposerPrompt } = require("./prompts");

let defaultMemoryRuntime = null;

// Memory 模块之外只能从本入口访问公开能力。后续阶段按真实调用需求
// 增加 application use case，不在这里暴露 domain/infrastructure 内部文件。
module.exports = Object.freeze({
  contracts,
  domain,
  loadMemoryV2Config,
  loadMemoryProviderConfig,
  createObserver,
  createNormalWritePipeline,
  createMemoryRecovery,
  createMemoryHousekeeping,
  createMemoryContextAssembly,
  createMemorySourceRebuild,
  createMemoryStateRecovery,
  createProjectionDrain,
  createDiagnosticProjection,
  createDefaultProjectionDrain(projectionKey, adapter) {
    return createProjectionDrain({ repositories, projectionKey, adapter });
  },
  createMemoryRetention,
  createPrivacyHardDelete,
  createMemoryMigration,
  createDefaultMemoryMigration({ config, projectionDrains, providerAdapter, now, monotonicNow } = {}) {
    if (!config?.enabled) throw new Error("Memory v2 must be enabled for data migration");
    const adapter = providerAdapter || createMemoryProviderAdapter({
      invokeStructured: createStructuredTransport(config.provider),
      promptLoader: loadProposerPrompt,
    });
    const observer = createObserver({
      sourceRepository: repositories.source,
      stateRepository: repositories.state,
      runtimeRepository: repositories.runtime,
      config,
    });
    const pipeline = createNormalWritePipeline({ observer, providerAdapter: adapter, repositories, config });
    const sourceRebuild = createMemorySourceRebuild({ repositories, normalWritePipeline: pipeline, config });
    return createMemoryMigration({ repositories, sourceRebuild, projectionDrains, now, monotonicNow });
  },
  createMemoryRuntime,
  createMemoryMetrics,
  createDefaultMemoryRuntime(options) {
    if (!defaultMemoryRuntime) defaultMemoryRuntime = createMemoryRuntime({ ...options, repositories });
    return defaultMemoryRuntime;
  },
  createDefaultMemoryContextAssembly(options) {
    if (options?.config?.enabled && !defaultMemoryRuntime) {
      throw new Error("Default Memory runtime must be initialized before context assembly");
    }
    return createMemoryContextAssembly({
      ...options,
      repositories,
      scheduleHousekeeping: options?.scheduleHousekeeping || defaultMemoryRuntime?.scheduleHousekeeping,
      scheduleStateRecovery: options?.scheduleStateRecovery || defaultMemoryRuntime?.scheduleStateRecovery,
      metrics: options?.metrics || defaultMemoryRuntime?.metrics,
    });
  },
  markRecoveryNotificationsDelivered(ids) {
    return repositories.sidecars.markRecoveryNotificationsDelivered(ids);
  },
  listSuppressionTombstones(userId, presetId, options) {
    return repositories.sidecars.listTombstones(userId, presetId, options);
  },
  createMemoryProviderAdapter,
  createMockMemoryProviderAdapter,
  createOpenAiStructuredTransport,
  createDeepSeekStrictToolsTransport,
  createStructuredTransport,
  runStructuredOutputPreflight,
  loadProposerPrompt,
});
