const { loadMemoryV2Config } = require("./configuration");
const { createMemoryModule } = require("./moduleFactory");

// Runtime callers receive only the composition factory and configuration loader.
// Operational, migration, probe, and diagnostic capabilities live in ./admin.
module.exports = Object.freeze({
  createMemoryModule,
  loadMemoryV2Config,
});
