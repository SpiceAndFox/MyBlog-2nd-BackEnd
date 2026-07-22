const { createApplicationComposition } = require("./app/composition/createApplication");
const { installProcessHandlers } = require("./services/serverLifecycle");

async function main() {
  const composition = createApplicationComposition();
  installProcessHandlers({ lifecycle: composition.lifecycle, logger: composition.logger });
  try {
    await composition.lifecycle.start();
  } catch (error) {
    composition.logger.error("server_startup_failed", {
      port: composition.config.serverConfig.port,
      host: composition.config.serverConfig.host,
      error,
    });
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main().catch((error) => {
    process.exitCode = 1;
    console.error("Application composition failed", error);
  });
}

module.exports = { createApplicationComposition, main };
