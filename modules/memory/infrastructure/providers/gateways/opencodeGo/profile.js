const mimoV25 = require("./models/mimoV25");
const mimoV25Pro = require("./models/mimoV25Pro");
const glm53Flash = require("./models/glm53Flash");

// Preserve the verified Memory OpenCode Go wire conventions. Models without
// exceptions inherit these defaults; no HTTP logic belongs in this catalog.
module.exports = {
  id: "opencode-go",
  defaults: { reasoningEncoding: "reasoning-effort", schemaPolicy: "strip-unique-items", headerPolicy: "opencode-session" },
  models: [mimoV25, mimoV25Pro, glm53Flash],
};
