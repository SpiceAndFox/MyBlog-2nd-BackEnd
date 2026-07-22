const { createTransactionExecutor } = require("../../../../shared/db/transactionExecutor");
const { createStateRepository } = require("./stateRepository");
const { createAuditRepository } = require("./auditRepository");
const { createRuntimeRepository } = require("./runtimeRepository");
const { createSidecarRepository } = require("./sidecarRepository");
const { createDiagnosticProjectionRepository } = require("./diagnosticProjectionRepository");
const { createPrivacyRepository } = require("./privacyRepository");
const { createMigrationRepository } = require("./migrationRepository");
const { createSourceWriteGuardRepository } = require("./sourceWriteGuardRepository");

function createMemoryInfrastructureRepositories({ database, transactionExecutor } = {}) {
  const transaction = transactionExecutor || createTransactionExecutor({ database });
  const dependencies = { database, transactionExecutor: transaction };
  return Object.freeze({
    state: createStateRepository(dependencies),
    audit: createAuditRepository(dependencies),
    runtime: createRuntimeRepository(dependencies),
    sidecars: createSidecarRepository(dependencies),
    diagnosticProjection: createDiagnosticProjectionRepository(dependencies),
    privacy: createPrivacyRepository(dependencies),
    migration: createMigrationRepository(dependencies),
    sourceWriteGuard: createSourceWriteGuardRepository(dependencies),
    withTransaction: transaction.run,
  });
}

module.exports = { createMemoryInfrastructureRepositories };
