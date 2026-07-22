const contracts = require("./contracts");
const domain = require("./domain");
const { loadMemoryV2Config } = require("./config/loadConfig");
const { loadMemoryProviderConfig } = require("./config/loadProviderConfig");
const { createRepositorySet } = require("./moduleFactory");
const { createObserver } = require("./application/observer");
const { createNormalWritePipeline } = require("./application/normalWritePipeline");
const { createMemorySourceRebuild } = require("./application/sourceRebuild");
const { createProjectionDrain } = require("./application/projectionDrain");
const { createMemoryMigration } = require("./application/migration");
const { createMemoryTaskShadowReplay } = require("./application/taskShadowReplay");
const { createProviderAdmission, admissionControlledAdapter } = require("./application/providerAdmission");
const { createMigrationProviderTelemetry } = require("./application/migrationTelemetry");
const { buildMigrationEvidence } = require("./application/migrationEvidence");
const { buildNormalEnvelope } = require("./application/envelope");
const {
  buildProposerTaskArtifact,
  expandProposerTaskArtifact,
} = require("./application/proposerTaskRenderer");
const { createSemanticCompiler } = require("./application/semanticCompiler");
const {
  createMemoryProviderAdapter,
  createMockMemoryProviderAdapter,
  buildProposerUserPayload,
  schemaRepairPrompt,
} = require("./infrastructure/providers/memoryProviderAdapter");
const { createStructuredTransport } = require("./infrastructure/providers/structuredTransportFactory");
const { runStructuredOutputPreflight } = require("./infrastructure/providers/providerPreflight");
const { buildOutputSchema } = require("./infrastructure/providers/outputSchema");
const { loadProposerPrompt } = require("./prompts");

function createMemoryAdministration({ database, transactionExecutor, sourceReader, userTimeZoneReader } = {}) {
  const repositories = createRepositorySet({ database, transactionExecutor, sourceReader, userTimeZoneReader });

  function createBoundProjectionDrain(projectionKey, adapter) {
    return createProjectionDrain({ repositories, projectionKey, adapter });
  }

  function createMigration({ config, projectionDrains, providerAdapter, providerTelemetry, now, monotonicNow } = {}) {
    if (!config?.enabled) throw new Error("Memory v2 must be enabled for data migration");
    const admission = createProviderAdmission(config.admission || { concurrency: 1, queueMax: 32 });
    const rawAdapter = providerAdapter || createMemoryProviderAdapter({
      invokeStructured: createStructuredTransport(config.provider),
      promptLoader: loadProposerPrompt,
    });
    const trackedAdapter = providerTelemetry?.wrapAdapter
      ? providerTelemetry.wrapAdapter(rawAdapter, {
        loadTaskAttempt: async (envelope) => {
          const task = await repositories.runtime.getTask(envelope?.task?.taskId);
          return task?.attempt;
        },
      })
      : rawAdapter;
    const adapter = admissionControlledAdapter(trackedAdapter, admission);
    const observer = createObserver({
      sourceRepository: repositories.source,
      stateRepository: repositories.state,
      runtimeRepository: repositories.runtime,
      config,
    });
    const pipeline = createNormalWritePipeline({ observer, providerAdapter: adapter, repositories, config });
    const sourceRebuild = createMemorySourceRebuild({ repositories, normalWritePipeline: pipeline, config });
    return createMemoryMigration({ repositories, sourceRebuild, projectionDrains, providerTelemetry, now, monotonicNow });
  }

  function createTaskShadowReplay({ config, providerAdapter } = {}) {
    if (!config?.enabled) throw new Error("Memory v2 must be enabled for task shadow replay");
    const adapter = providerAdapter || createMemoryProviderAdapter({
      invokeStructured: createStructuredTransport(config.provider),
      promptLoader: loadProposerPrompt,
    });
    return createMemoryTaskShadowReplay({ repositories, config, providerAdapter: adapter });
  }

  return Object.freeze({
    createMigration,
    createProjectionDrain: createBoundProjectionDrain,
    createTaskShadowReplay,
  });
}

module.exports = Object.freeze({
  buildMigrationEvidence,
  buildNormalEnvelope,
  buildOutputSchema,
  buildProposerUserPayload,
  buildProposerTaskArtifact,
  contracts,
  createMemoryAdministration,
  createMemoryProviderAdapter,
  createMigrationProviderTelemetry,
  createMockMemoryProviderAdapter,
  createSemanticCompiler,
  createStructuredTransport,
  domain,
  expandProposerTaskArtifact,
  loadMemoryProviderConfig,
  loadMemoryV2Config,
  loadProposerPrompt,
  runStructuredOutputPreflight,
  schemaRepairPrompt,
});
