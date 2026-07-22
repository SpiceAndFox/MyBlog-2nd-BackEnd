module.exports = {
  state: require("./stateRepository"),
  audit: require("./auditRepository"),
  runtime: require("./runtimeRepository"),
  sidecars: require("./sidecarRepository"),
  diagnosticProjection: require("./diagnosticProjectionRepository"),
  privacy: require("./privacyRepository"),
  migration: require("./migrationRepository"),
  withTransaction: require("./helpers").withTransaction,
};
