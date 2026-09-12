const contracts = require("./contracts");
const domain = require("./domain");
const { loadMemoryV2Config, loadMemoryProviderConfig } = require("./configuration");
const { resolveMemoryProviderModel } = require("./config/loadProviderConfig");
const { createRepositorySet } = require("./moduleFactory");
const { createObserver } = require("./application/observer");
const { createNormalWritePipeline } = require("./application/normalWritePipeline");
const { createMemorySourceRebuild } = require("./application/sourceRebuild");
const { createMemoryLibrarian } = require("./application/librarian");
const { createMemoryMigration } = require("./application/migration");
const { createMemoryTaskShadowReplay } = require("./application/taskShadowReplay");
const { createProviderAdmission, admissionControlledAdapter } = require("./application/providerAdmission");
const { createProviderRequestControl } = require("./application/providerRequestRecovery");
const { createProviderHealth } = require("../../shared/observability/providerHealth");
const { createMigrationProviderTelemetry } = require("./application/migrationTelemetry");
const { buildMigrationEvidence } = require("./application/migrationEvidence");
const { latestRejectedOutput, createRepairFeedback, repairContextForInput } = require("./application/outputRepair");
const { buildNormalEnvelope, buildMaintenanceEnvelope } = require("./application/envelope");
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
  schemaRepairRequest,
} = require("./infrastructure/providers/memoryProviderAdapter");
const { createStructuredTransport } = require("./infrastructure/providers/structuredTransportFactory");
const { runStructuredOutputPreflight } = require("./infrastructure/providers/diagnostics/providerPreflight");
const { buildOutputSchema } = require("./infrastructure/providers/output/outputSchema");
const { buildProviderRequestPreviews } = require("./infrastructure/providers/diagnostics/providerRequestPreview");
const { loadProposerPrompt } = require("./prompts");
const { createRetryBudget } = require("./application/retryBudget");

function createMemoryAdministration({ database, transactionExecutor, sourceReader, userTimeZoneReader } = {}) {
  const repositories = createRepositorySet({ database, transactionExecutor, sourceReader, userTimeZoneReader });

  function createLibrarianStack({ config, providerAdapter, decorateAdapter = (adapter) => adapter }) {
    const retryBudget = createRetryBudget();
    const health = createProviderHealth({ name: "memory" });
    const admission = createProviderAdmission(config.admission);
    const rawAdapter = providerAdapter || createMemoryProviderAdapter({
      invokeStructured: createStructuredTransport(config.provider),
      promptLoader: loadProposerPrompt,
      requestControl: createProviderRequestControl({ health, retryBudget, config }),
    });
    const decorated = decorateAdapter(rawAdapter);
    const adapter = admissionControlledAdapter(decorated, admission);
    const observer = createObserver({
      sourceRepository: repositories.source,
      stateRepository: repositories.state,
      runtimeRepository: repositories.runtime,
      config,
    });
    const pipeline = createNormalWritePipeline({
      retryBudget,
      observer,
      providerAdapter: adapter,
      repositories,
      config,
    });
    let sourceRebuild;
    const librarian = createMemoryLibrarian({
      retryBudget,
      repositories,
      providerAdapter: adapter,
      config,
      drainBarrier: (userId, presetId, options) =>
        sourceRebuild.forceDrainTargetsTo(userId, presetId, options),
    });
    sourceRebuild = createMemorySourceRebuild({
      repositories,
      normalWritePipeline: pipeline,
      librarian,
      config,
    });
    return { librarian, sourceRebuild, retryBudget };
  }

  function createMigration({ config, providerAdapter, providerTelemetry, now, monotonicNow } = {}) {
    if (!config?.enabled) throw new Error("Memory v2 must be enabled for data migration");
    const { sourceRebuild, retryBudget } = createLibrarianStack({
      config,
      providerAdapter,
      decorateAdapter: (adapter) => providerTelemetry?.wrapAdapter
        ? providerTelemetry.wrapAdapter(adapter, {
          loadTaskAttempt: async (envelope) => {
            const task = await repositories.runtime.getTask(envelope?.task?.taskId);
            return task?.attempt;
          },
        })
        : adapter,
    });
    return createMemoryMigration({ repositories, sourceRebuild, providerTelemetry, now, monotonicNow, retryBudget });
  }

  function createLibrarian({ config, providerAdapter } = {}) {
    if (!config?.enabled) throw new Error("Memory v2 must be enabled for Librarian maintenance");
    return createLibrarianStack({ config, providerAdapter }).librarian;
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
    createLibrarian,
    createTaskShadowReplay,
  });
}

module.exports = Object.freeze({
  summarizeOperation: require("./application/operationRunner").summarizeOperation,
  buildMigrationEvidence,
  buildNormalEnvelope,
  buildMaintenanceEnvelope,
  ...require("./application/librarianRenderer"),
  ...require("./application/evidenceInput"),
  buildOutputSchema,
  buildProviderRequestPreviews,
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
  resolveMemoryProviderModel,
  loadMemoryV2Config,
  loadProposerPrompt,
  latestRejectedOutput,
  repairContextForInput,
  createRepairFeedback,
  runStructuredOutputPreflight,
  schemaRepairPrompt,
  schemaRepairRequest,
});
