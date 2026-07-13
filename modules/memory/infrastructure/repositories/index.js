module.exports = {
  state: require("./stateRepository"),
  audit: require("./auditRepository"),
  runtime: require("./runtimeRepository"),
  source: require("./sourceRepository"),
  sidecars: require("./sidecarRepository"),
  diagnosticProjection: require("./diagnosticProjectionRepository"),
  privacy: require("./privacyRepository"),
  migration: require("./migrationRepository"),
  users: require("./userRepository"),
  withTransaction: require("./helpers").withTransaction,
};
